/**
 * Runs code from `execute` in a Deno subprocess: type-checked against the generated declarations first, then
 * run with network access to the API host only, read and write access to the data directory only, no
 * environment, no subprocesses. The API key reaches it on stdin, never through the environment or the code.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { download, type ApiOptions } from "../api.js";

export interface SandboxOptions {
  api: ApiOptions;
  userAgent: string;
  /** Cache and store live here; defaults to APINOA_MCP_DATA_DIR or ~/.apinoa-mcp. */
  dataDir?: string;
  /** Parallel API calls in one run. */
  concurrency?: number;
  /** How long an answer may be reused, in ms (0 turns the cache off). */
  cacheTtlMs?: number;
  /** Most characters of output (printed text and the returned value) handed back to the model. */
  maxOutputChars?: number;
  /** The deno executable; found in the package's own dependency, then on PATH. */
  deno?: string;
}

export interface RunStats {
  calls: number;
  cached: number;
  units: number;
  failed: number;
  errors: string[];
}

export interface RunResult {
  ok: boolean;
  /** The text the model sees. */
  text: string;
  stats: RunStats;
}

// Lines of main.ts above the user's code: line numbers in errors are shifted back by this many.
const HEADER_LINES = 4;

export function findDeno(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.APINOA_MCP_DENO) return process.env.APINOA_MCP_DENO;
  try {
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve("deno/package.json"));
    const exe = join(dir, process.platform === "win32" ? "deno.exe" : "deno");
    if (existsSync(exe)) return exe;
    // The package's postinstall did not run (npm --ignore-scripts): its own installer finds the binary.
    return require("deno/install_api.cjs").runInstall() as string;
  } catch {
    return "deno";
  }
}

/** Whether the deno at `path` runs. */
export function denoRuns(path: string): boolean {
  try {
    return spawnSync(path, ["--version"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

export class Sandbox {
  private readonly deno: string;
  private readonly dataDir: string;
  private readonly runtimeDir: string;
  private readonly prelude: string;
  private readonly host: string;
  private prepared?: Promise<void>;

  constructor(
    private readonly opts: SandboxOptions,
    private readonly declarations: string,
    private readonly operations: Record<string, Record<string, [string, number]>>,
  ) {
    this.deno = findDeno(opts.deno);
    this.dataDir = opts.dataDir ?? process.env.APINOA_MCP_DATA_DIR ?? join(homedir(), ".apinoa-mcp");
    const hash = createHash("sha256").update(declarations).digest("hex").slice(0, 12);
    this.runtimeDir = join(tmpdir(), `apinoa-mcp-${hash}`);
    this.prelude = join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "prelude.js");
    const u = new URL(opts.api.baseUrl);
    this.host = u.host;
  }

  private prepare(): Promise<void> {
    return (this.prepared ??= (async () => {
      await mkdir(this.runtimeDir, { recursive: true });
      await writeFile(join(this.runtimeDir, "apinoa.d.ts"), this.declarations);
      // Not strict: the check is there to catch methods, parameters and fields that do not exist, not to make
      // the model prove every optional field is present.
      await writeFile(join(this.runtimeDir, "deno.json"), JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false } }));
      for (const d of ["cache", "store", "files"]) await mkdir(join(this.dataDir, d), { recursive: true });
      await pruneCache(join(this.dataDir, "cache"), this.cacheTtlMs);
    })());
  }

  private get cacheTtlMs() {
    return this.opts.cacheTtlMs ?? Number(process.env.APINOA_MCP_CACHE_TTL_S ?? 600) * 1000;
  }

  async run(
    code: string,
    budget: number,
    timeoutMs: number,
    onProgress?: (s: RunStats) => void,
  ): Promise<RunResult> {
    await this.prepare();
    const runDir = await mkdtemp(join(tmpdir(), "apinoa-run-"));
    const nonce = randomBytes(9).toString("hex");
    const main = [
      `/// <reference types="${pathToFileURL(join(this.runtimeDir, "apinoa.d.ts")).href}" />`,
      `// @ts-ignore: the runtime is plain JavaScript`,
      `import { __run } from "${pathToFileURL(this.prelude).href}";`,
      `await __run(async () => {`,
      code,
      `});`,
      "",
    ].join("\n");
    await writeFile(join(runDir, "main.ts"), main);

    const args = [
      "run", "--check", "--quiet", "--no-prompt", "--no-remote", "--no-npm",
      `--config=${join(this.runtimeDir, "deno.json")}`,
      `--allow-net=${this.host}`,
      `--allow-read=${this.dataDir}`,
      `--allow-write=${this.dataDir}`,
      "--v8-flags=--max-old-space-size=1024",
      join(runDir, "main.ts"),
    ];
    const child = spawn(this.deno, args, {
      cwd: runDir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), NO_COLOR: "1", ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(
      JSON.stringify({
        key: this.opts.api.apiKey ?? "",
        baseUrl: this.opts.api.baseUrl,
        budget,
        concurrency: this.opts.concurrency ?? Number(process.env.APINOA_MCP_CONCURRENCY ?? 16),
        cacheTtlMs: this.cacheTtlMs,
        dataDir: this.dataDir,
        nonce,
        userAgent: this.opts.userAgent,
        operations: this.operations,
      }) + "\n",
    );

    const maxOut = this.opts.maxOutputChars ?? Number(process.env.APINOA_MCP_MAX_OUTPUT ?? 40_000);
    let printed = "";
    let printedTotal = 0;
    let stderr = "";
    let done: any;
    let lastStats: RunStats = { calls: 0, cached: 0, units: 0, failed: 0, errors: [] };
    let buf = "";
    const marker = (kind: string) => `@@APINOA_${kind}_${nonce}@@ `;

    const onLine = (line: string) => {
      if (line.startsWith(marker("DONE"))) {
        done = JSON.parse(line.slice(marker("DONE").length));
      } else if (line.startsWith(marker("PROGRESS"))) {
        lastStats = JSON.parse(line.slice(marker("PROGRESS").length));
        onProgress?.(lastStats);
      } else if (line.startsWith(marker("RPC"))) {
        void this.answer(JSON.parse(line.slice(marker("RPC").length)), (reply) => {
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(reply) + "\n");
        });
      } else {
        printedTotal += line.length + 1;
        if (printed.length < maxOut) printed += line + "\n";
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const started = Date.now();
    const exit = await new Promise<number | null>((resolve) => {
      child.on("close", (c) => resolve(c));
      child.on("error", (e) => {
        stderr += `\n${(e as Error).message}`;
        resolve(-1);
      });
    });
    clearTimeout(timer);
    if (buf) onLine(buf);
    await rm(runDir, { recursive: true, force: true });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (exit === -1 && /ENOENT/.test(stderr)) {
      return fail(`Code mode needs Deno, and none was found (looked for ${this.deno}). Install it (npm i -g deno, or https://deno.com) or set APINOA_MCP_DENO to its path.`, lastStats);
    }
    const stats: RunStats = done?.stats ?? lastStats;
    const usage = usageLine(stats, budget, seconds);
    const out = clip(printed.replace(/\n+$/, ""), printedTotal, maxOut);

    if (!done) {
      const typeErrors = typeCheckErrors(stderr);
      if (typeErrors) return fail(`The code did not type-check, so nothing ran and nothing was billed:\n${typeErrors}\n\nsearch_docs shows each call's parameters and the fields it returns.`, stats);
      if (timedOut) return fail(`The run was stopped after ${Math.round(timeoutMs / 1000)} s.${out ? `\n\nPrinted before it stopped:\n${out}` : ""}\n\n${usage}\nFor long jobs: keep each run shorter (fewer items, or store.save progress and continue in another run; cached answers are free).`, stats);
      return fail(`The run failed: ${cleanError(stderr) || `exit code ${exit}`}${out ? `\n\nPrinted:\n${out}` : ""}\n\n${usage}`, stats);
    }
    if (!done.ok) {
      const where = lineOf(done.stack);
      return fail(`Error${where ? ` (line ${where})` : ""}: ${done.error}${out ? `\n\nPrinted before the error:\n${out}` : ""}\n\n${usage}`, stats);
    }
    const result = done.result === null || done.result === undefined ? "" : JSON.stringify(done.result, null, 1);
    const shown = clip(result, result.length, Math.max(2000, maxOut - out.length));
    const parts = [out && `Printed:\n${out}`, shown && `Returned:\n${shown}`, usage].filter(Boolean);
    return { ok: true, text: parts.join("\n\n"), stats };
  }

  /** A request from the sandbox: only the image download image-search needs. */
  private async answer(req: { id: number; method: string; url?: string }, reply: (r: unknown) => void) {
    if (req.method !== "download" || typeof req.url !== "string") return reply({ id: req.id, ok: false, error: `unknown request ${req.method}` });
    try {
      const img = await download(this.opts.api, req.url);
      if (!img.contentType.startsWith("image/")) throw new Error(`the URL is ${img.contentType}, not an image`);
      reply({ id: req.id, ok: true, contentType: img.contentType, data: Buffer.from(img.bytes).toString("base64") });
    } catch (e) {
      reply({ id: req.id, ok: false, error: (e as Error).message.replace(/^[A-Z_]+: /, "") });
    }
  }
}

function fail(text: string, stats: RunStats): RunResult {
  return { ok: false, text, stats };
}

function usageLine(s: RunStats, budget: number, seconds: string): string {
  const errs = s.failed ? `, ${s.failed} failed (${s.errors.slice(0, 3).join("; ")})` : "";
  return `[apinoa: ${s.calls} call${s.calls === 1 ? "" : "s"}${s.cached ? ` + ${s.cached} from cache` : ""}, ${s.units} of ${budget} units ($${(s.units / 1000).toFixed(3)}), ${seconds} s${errs}]`;
}

function clip(text: string, total: number, max: number): string {
  if (text.length <= max && total <= max + 1) return text;
  return `${text.slice(0, max)}\n…[cut: ${total} characters, ${max} shown. Return or print less: aggregate in the code, or store.save the full data and return a summary]`;
}

/** Deno's type errors, with line numbers counted in the user's code. */
export function typeCheckErrors(stderr: string): string {
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/TS\d+ \[ERROR\]/.test(clean)) return "";
  const errors: string[] = [];
  const re = /TS(\d+) \[ERROR\]: ([\s\S]*?)\n\s+at [^\n]*main\.ts:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) && errors.length < 10) {
    const line = Number(m[3]) - HEADER_LINES;
    const msg = m[2]!.split("\n").map((l) => l.trim()).filter((l) => l && !/^\d+\s*\|/.test(l) && !/^~+$/.test(l) && !/^\^/.test(l)).join(" ");
    errors.push(`- line ${line}: ${msg} (TS${m[1]})`);
  }
  return errors.length ? errors.join("\n") : clean.slice(0, 2000);
}

function lineOf(stack: string): number | undefined {
  const m = /main\.ts:(\d+):\d+/.exec(stack ?? "");
  return m ? Number(m[1]) - HEADER_LINES : undefined;
}

function cleanError(stderr: string): string {
  return stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/file:\/\/\S*main\.ts:(\d+)/g, (_m, l) => `line ${Number(l) - HEADER_LINES}`).trim().slice(0, 2000);
}

async function pruneCache(dir: string, ttlMs: number) {
  try {
    const now = Date.now();
    for (const f of await readdir(dir)) {
      const p = join(dir, f);
      const s = await stat(p);
      if (now - s.mtimeMs > Math.max(ttlMs, 60_000)) await rm(p, { force: true });
    }
  } catch {
    // nothing to prune
  }
}
