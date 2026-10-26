/**
 * The runtime code written for `execute` runs inside: a Deno subprocess that may reach only the API host and
 * read and write only the data directory. It builds the `apinoa` client from the catalog the server sends,
 * meters every call against the budget, caches answers, and reports back to the server on stdout.
 *
 * Compiled by tsc like the rest of the package; Deno runs the emitted dist/sandbox/prelude.js.
 */
declare const Deno: any;

interface Config {
  key: string;
  baseUrl: string;
  budget: number;
  concurrency: number;
  cacheTtlMs: number;
  dataDir: string;
  nonce: string;
  userAgent: string;
  /** platform → operation → [method name, cost of one call] */
  operations: Record<string, Record<string, [string, number]>>;
}

interface Stats {
  calls: number;
  cached: number;
  units: number;
  failed: number;
  errors: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Taken before the code runs: code that replaces globalThis.fetch never sees the key the client sends.
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

// Codes worth another try (https://apinoa.com/docs/errors#retrying). Every other failure fails the same way again.
const RETRYABLE = new Set([
  "CAPACITY_SATURATED", "MARKETPLACE_SATURATED", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR",
  "UPSTREAM_ERROR", "UPSTREAM_READ_FAILED", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE",
]);
// Failures no other call will get past: they end the run instead of being skipped by many().
const FATAL = new Set(["UNAUTHORIZED", "INSUFFICIENT_BALANCE", "ACCOUNT_SUSPENDED", "FORBIDDEN", "QUOTA_EXCEEDED", "BUDGET_EXCEEDED"]);

export class ApinoaError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly requestId?: string) {
    super(`${code}: ${message}`);
    this.name = "ApinoaError";
  }
}

let config!: Config;
const stats: Stats = { calls: 0, cached: 0, units: 0, failed: 0, errors: [] };
const pending = new Map<number, (reply: any) => void>();
let rpcId = 0;

function send(kind: "DONE" | "RPC" | "PROGRESS", payload: unknown) {
  Deno.stdout.writeSync(encoder.encode(`\n@@APINOA_${kind}_${config.nonce}@@ ${JSON.stringify(payload)}\n`));
}

/** Lines on stdin: the config first, then the server's replies to RPC requests. */
async function readStdin(onConfig: (c: Config) => void) {
  let buf = "";
  let first = true;
  for await (const chunk of Deno.stdin.readable) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (first) {
        first = false;
        onConfig(msg);
      } else pending.get(msg.id)?.(msg);
    }
  }
}

function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve) => {
    pending.set(id, (reply) => {
      pending.delete(id);
      resolve(reply);
    });
    send("RPC", { id, method, ...params });
  });
}

// ---- calls ---------------------------------------------------------------------------------------------

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (active >= config.concurrency) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await f();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return q.toString();
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cacheRead(key: string): Promise<unknown | undefined> {
  if (config.cacheTtlMs <= 0) return undefined;
  try {
    const hit = JSON.parse(await Deno.readTextFile(`${config.dataDir}/cache/${key}.json`));
    return Date.now() - hit.t < config.cacheTtlMs ? hit.data : undefined;
  } catch {
    return undefined;
  }
}

async function cacheWrite(key: string, data: unknown) {
  if (config.cacheTtlMs <= 0) return;
  try {
    const text = JSON.stringify({ t: Date.now(), data });
    // A file (a video's bytes) is not kept: store.saveFile is the place for it.
    if (text.length > 2_000_000) return;
    await Deno.writeTextFile(`${config.dataDir}/cache/${key}.json`, text);
  } catch {
    // a full disk costs a cache entry, never the call
  }
}

function record(e: unknown) {
  stats.failed++;
  if (stats.errors.length < 5) stats.errors.push(e instanceof Error ? e.message : String(e));
}

async function call(platform: string, operation: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const p: Record<string, unknown> = { ...params };
  // An image may be given by URL; the server downloads it, since this sandbox reaches only the API.
  if (typeof p.image === "string" || (p.image && typeof p.image === "object" && "url" in (p.image as object))) {
    const url = typeof p.image === "string" ? p.image : (p.image as { url: string }).url;
    const got = await rpc("download", { url });
    if (!got.ok) throw new ApinoaError("IMAGE_DOWNLOAD_FAILED", got.error, 400);
    p.image = { contentType: got.contentType, data: got.data };
  }
  const post = Object.values(p).some((v) => v !== null && typeof v === "object" && !Array.isArray(v));
  const path = `/v1/${encodeURIComponent(platform)}/${encodeURIComponent(operation)}`;
  const query = post ? "" : toQuery(p);
  const key = post ? "" : await sha256(`${path}?${query}`);
  if (key) {
    const hit = await cacheRead(key);
    if (hit !== undefined) {
      stats.cached++;
      return hit;
    }
  }
  return slot(async () => {
    for (let attempt = 0; ; attempt++) {
      if (stats.units >= config.budget) {
        throw new ApinoaError("BUDGET_EXCEEDED", `the run's budget of ${config.budget} units is spent (${stats.calls} calls). Run again with a larger budget_units, or save progress with store.save and continue in the next run.`, 402);
      }
      let res: Response;
      try {
        res = await realFetch(config.baseUrl + path + (query ? `?${query}` : ""), {
          method: post ? "POST" : "GET",
          headers: { "x-api-key": config.key, "user-agent": config.userAgent, ...(post ? { "content-type": "application/json" } : {}) },
          body: post ? JSON.stringify(p) : undefined,
        });
      } catch (e) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApinoaError("NETWORK_ERROR", e instanceof Error ? e.message : String(e), 0);
      }
      stats.calls++;
      stats.units += Number(res.headers.get("x-apinoa-cost")) || 0;
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (res.ok && body?.success !== false && body?.data !== undefined) {
        if (key) await cacheWrite(key, body.data);
        return body.data;
      }
      const code = body?.error?.code ?? (res.status >= 500 ? "UPSTREAM_ERROR" : `HTTP_${res.status}`);
      const message = body?.error?.message ?? (text.slice(0, 200) || res.statusText);
      if ((RETRYABLE.has(code) || res.status === 429 || res.status >= 500) && attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Math.min(10_000, (after > 0 ? after : 2 ** attempt) * 1000));
        continue;
      }
      throw new ApinoaError(code, message, res.status, body?.requestId ?? res.headers.get("x-request-id") ?? undefined);
    }
  });
}

function client(): Record<string, Record<string, (params?: Record<string, unknown>) => Promise<unknown>>> {
  const out: Record<string, Record<string, (params?: Record<string, unknown>) => Promise<unknown>>> = {};
  for (const [platform, ops] of Object.entries(config.operations)) {
    out[platform] = {};
    for (const [operation, [method]] of Object.entries(ops)) {
      out[platform][method] = (params?: Record<string, unknown>) => call(platform, operation, params ?? {});
    }
  }
  return out;
}

// ---- helpers -------------------------------------------------------------------------------------------

async function pages(op: (params: any) => Promise<any>, params: Record<string, unknown> = {}, options: { maxPages?: number; maxItems?: number } = {}) {
  const maxPages = options.maxPages ?? 5;
  const maxItems = options.maxItems ?? Infinity;
  const items: unknown[] = [];
  let page = await op(params);
  for (let n = 1; ; n++) {
    items.push(...(page?.items ?? []));
    if (items.length >= maxItems || n >= maxPages || !page?.cursor || !(page?.items ?? []).length) break;
    page = await op({ cursor: page.cursor });
  }
  return Number.isFinite(maxItems) ? items.slice(0, maxItems) : items;
}

async function many<I, R>(items: readonly I[], fn: (item: I, index: number) => Promise<R>, options: { concurrency?: number } = {}) {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        if (e instanceof ApinoaError && FATAL.has(e.code)) throw e;
        record(e);
        out[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, items.length)) }, worker));
  return out;
}

const safeName = (name: string) => {
  const n = String(name).replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  if (!n) throw new Error("store: give a name of letters, digits, '.', '-' or '_'");
  return n;
};

const store = {
  async save(name: string, value: unknown): Promise<string> {
    const path = `${config.dataDir}/store/${safeName(name)}.json`;
    await Deno.writeTextFile(path, JSON.stringify(value));
    return path;
  },
  async load(name: string): Promise<unknown> {
    try {
      return JSON.parse(await Deno.readTextFile(`${config.dataDir}/store/${safeName(name)}.json`));
    } catch {
      return undefined;
    }
  },
  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const e of Deno.readDir(`${config.dataDir}/store`)) if (e.isFile && e.name.endsWith(".json")) names.push(e.name.slice(0, -5));
    return names.sort();
  },
  async saveFile(name: string, base64: string): Promise<string> {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const path = `${config.dataDir}/files/${safeName(name)}`;
    await Deno.writeFile(path, bytes);
    return path;
  },
};

function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return String(value);
  }
}

/** Runs the code: waits for the config, sets up the globals, then reports the result or the error, and the usage. */
export async function __run(fn: () => Promise<unknown>) {
  const ready = new Promise<void>((resolve) => {
    readStdin((c) => {
      config = c;
      resolve();
    }).catch(() => {});
  });
  await ready;
  for (const d of ["cache", "store", "files"]) await Deno.mkdir(`${config.dataDir}/${d}`, { recursive: true });
  Object.assign(globalThis, { apinoa: client(), pages, many, store, ApinoaError, usage: { get calls() { return stats.calls; }, get units() { return stats.units; }, get budget() { return config.budget; } } });
  const ticker = setInterval(() => send("PROGRESS", stats), 2000);
  let report: Record<string, unknown>;
  try {
    report = { ok: true, result: serialize(await fn()) };
  } catch (e) {
    const err = e as Error;
    report = { ok: false, error: err instanceof ApinoaError ? err.message : `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, stack: err?.stack ?? "" };
  }
  clearInterval(ticker);
  send("DONE", { ...report, stats });
  Deno.exit(0);
}
