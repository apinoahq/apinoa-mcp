/**
 * What code mode tells the model: the typed `apinoa` client (for the type check and for search_docs), built
 * from the live catalog so a new platform or parameter appears without a release, and the response types
 * from the OpenAPI snapshot.
 */
import type { CatalogEntry } from "../api.js";
import { RETURNS, SCHEMA_TYPES } from "../schema.snapshot.js";

type Param = { name: string; type: string; required: boolean; description: string };

export interface Operation {
  platform: string;
  operation: string;
  method: string;
  returns: string;
  cost: { base: number; max: number } | undefined;
  params: Param[];
  paged: boolean;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());

// When the OpenAPI snapshot predates an operation, its shape still follows the shared vocabulary.
const BY_NAME: Record<string, string> = {
  profile: "Account", profiles: "AccountPage", post: "Post", posts: "PostPage", comments: "CommentPage",
  group: "Group", groups: "GroupPage", job: "Job", jobs: "JobPage", media: "MediaFile", search: "SearchResult",
  browse: "SearchResult", "image-search": "SearchResult", product: "Product", reviews: "ReviewPage",
  categories: "CategoryList", shipping: "ShippingQuote", catalog: "Catalog",
};

const TYPE_NAMES = new Set([...SCHEMA_TYPES.matchAll(/^(?:interface|type) (\w+)/gm)].map((m) => m[1]!));

function paramType(s: any): string {
  if (!s || typeof s !== "object") return "unknown";
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).map(paramType))].join(" | ");
  switch (s.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return `${paramType(s.items)}[]`;
    // The one object input is an image: bytes, or a URL the server downloads.
    case "object": return "string | { url: string } | { contentType: string; data: string }";
    default: return "unknown";
  }
}

export function operations(catalog: CatalogEntry[]): Operation[] {
  const out: Operation[] = [];
  for (const e of catalog) {
    for (const op of e.operations) {
      const schema = (e.params?.[op] ?? {}) as { properties?: Record<string, any>; required?: string[] };
      const required = new Set(schema.required ?? []);
      const params = Object.entries(schema.properties ?? {}).map(([name, s]) => ({
        name,
        type: paramType(s),
        required: required.has(name),
        description: String(s?.description ?? "").replace(/\s+/g, " ").trim(),
      }));
      const declared = RETURNS[`${e.id}/${op}`] ?? BY_NAME[op];
      out.push({
        platform: e.id,
        operation: op,
        method: camel(op),
        returns: declared && TYPE_NAMES.has(declared) ? declared : "any",
        cost: e.cost?.[op],
        params,
        paged: params.some((p) => p.name === "cursor") || /Page$/.test(declared ?? ""),
      });
    }
  }
  return out;
}

const price = (c: Operation["cost"]) => (c ? (c.base === c.max ? `${c.base} unit${c.base === 1 ? "" : "s"}` : `${c.base}–${c.max} units`) : "price in the catalog");
const paramsName = (o: Operation) => `${pascal(o.platform)}${pascal(o.method)}Params`;
const comment = (text: string, pad: string) => (text ? `${pad}/** ${text.replace(/\*\//g, "* /")} */\n` : "");

function paramsInterface(o: Operation): string {
  const fields = o.params.map((p) => `${comment(p.description, "  ")}  ${/^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name)}${p.required ? "" : "?"}: ${p.type};`);
  return `interface ${paramsName(o)} {\n${fields.join("\n")}\n}`;
}

const signature = (o: Operation) =>
  `${o.method}(params${o.params.some((p) => p.required) ? "" : "?"}: ${paramsName(o)}): Promise<${o.returns}>`;

const HELPERS = `/** An API refusal: \`code\` is the stable code (NOT_FOUND, INVALID_PARAMS, …), \`status\` the HTTP status. */
declare class ApinoaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
}
/** Every page of a paged operation (anything returning a *Page), following \`cursor\`. Default at most 5 pages. */
declare function pages<P, T>(op: (params: P) => Promise<{ items: T[]; cursor?: string }>, params: P, options?: { maxPages?: number; maxItems?: number }): Promise<T[]>;
/** fn over every item, \`concurrency\` at a time (default 8). An item whose call fails comes back undefined and is counted in the usage line; a fatal error (no balance, budget spent) stops the run. */
declare function many<I, R>(items: readonly I[], fn: (item: I, index: number) => Promise<R>, options?: { concurrency?: number }): Promise<(R | undefined)[]>;
/** JSON kept on this machine between runs (and sessions), and files such as downloaded videos. */
declare const store: {
  save(name: string, value: unknown): Promise<string>;
  load<T = any>(name: string): Promise<T | undefined>;
  list(): Promise<string[]>;
  /** Writes base64 bytes (e.g. a MediaFile's data) to a file; returns its path. */
  saveFile(name: string, base64: string): Promise<string>;
};
/** This run's spend so far. */
declare const usage: { readonly calls: number; readonly units: number; readonly budget: number };`;

/** The declarations code in \`execute\` is type-checked against. */
export function declarations(ops: Operation[]): string {
  const platforms = [...new Set(ops.map((o) => o.platform))];
  const client = platforms
    .map((p) => {
      const methods = ops
        .filter((o) => o.platform === p)
        .map((o) => `    /** ${o.platform}/${o.operation}: ${price(o.cost)} a call. */\n    ${signature(o)};`);
      return `  ${p}: {\n${methods.join("\n")}\n  };`;
    })
    .join("\n");
  return [
    "// Types for code run by apinoa-mcp's execute tool. Generated from the API catalog and OpenAPI document.",
    SCHEMA_TYPES,
    ...ops.map(paramsInterface),
    `/** The apinoa API, one method per operation. Each call returns the answer's \`data\`; a refusal throws ApinoaError. */\ndeclare const apinoa: {\n${client}\n};`,
    HELPERS,
  ].join("\n\n");
}

/** What the sandbox needs to build the client: platform → operation → [method, cost]. */
export function sandboxOperations(ops: Operation[]): Record<string, Record<string, [string, number]>> {
  const out: Record<string, Record<string, [string, number]>> = {};
  for (const o of ops) (out[o.platform] ??= {})[o.operation] = [o.method, o.cost?.base ?? 1];
  return out;
}

// ---- search_docs ---------------------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  posts: ["video", "videos", "reel", "reels", "short", "shorts", "tweet", "tweets", "thread", "threads", "feed", "trending", "uploads", "content", "hashtag", "sound"],
  profile: ["account", "user", "creator", "channel", "followers", "follower", "bio", "handle", "page"],
  profiles: ["followers", "following", "channels"],
  comments: ["comment", "replies", "reply", "discussion"],
  search: ["find", "keyword", "products", "shop", "shopping", "price", "prices"],
  product: ["item", "details", "variants", "asin", "price"],
  reviews: ["review", "ratings", "rating", "stars"],
  media: ["download", "mp4", "file", "video"],
  groups: ["playlists", "communities", "subreddits"],
  group: ["community", "subreddit", "hashtag", "sound"],
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9@#_-]+/).map((w) => w.replace(/^[#@]/, "")).filter((w) => w.length > 1);

function score(o: Operation, query: string[]): number {
  let s = 0;
  const syn = SYNONYMS[o.operation] ?? [];
  for (const w of query) {
    const stem = w.replace(/s$/, "");
    if (w === o.platform || (o.platform === "x" && w === "twitter") || (o.platform === "youtube" && w === "yt")) s += 4;
    if (w === o.operation || stem === o.operation.replace(/s$/, "") || w === o.method.toLowerCase()) s += 4;
    if (syn.includes(w)) s += 2;
    for (const p of o.params) {
      if (p.name.toLowerCase() === w || p.name.toLowerCase() === stem) s += 2;
      else if (p.description.toLowerCase().includes(w)) s += 0.3;
    }
  }
  return s;
}

/** The referenced response types, breadth-first from the operations' return types, up to a size. */
function typesFor(roots: string[], maxChars = 9000): string {
  const blocks = new Map<string, string>();
  for (const m of SCHEMA_TYPES.matchAll(/^(?:\/\*\*[^\n]*\*\/\n)?(?:interface|type) (\w+)[\s\S]*?(?=^(?:\/\*\*|interface |type )|(?![\s\S]))/gm)) {
    blocks.set(m[1]!, m[0]!.trimEnd());
  }
  const seen = new Set<string>();
  const queue = roots.filter((r) => blocks.has(r));
  const out: string[] = [];
  let size = 0;
  const skipped: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const block = blocks.get(name)!;
    if (size + block.length > maxChars && out.length) {
      skipped.push(name);
      continue;
    }
    out.push(block);
    size += block.length;
    for (const ref of block.matchAll(/\b([A-Z]\w+)\b/g)) if (blocks.has(ref[1]!) && !seen.has(ref[1]!)) queue.push(ref[1]!);
  }
  const more = skipped.length ? `\n// Not shown (ask search_docs for them by name): ${[...new Set(skipped)].join(", ")}` : "";
  return out.join("\n") + more;
}

function describe(o: Operation): string {
  const params = o.params.map((p) => `    ${p.name}${p.required ? "" : "?"}: ${p.type}${p.description ? ` — ${p.description}` : ""}`).join("\n");
  const paging = o.paged
    ? `\n  Next page: apinoa.${o.platform}.${o.method}({ cursor }) with the previous answer's cursor alone, or pages(apinoa.${o.platform}.${o.method}, { … }, { maxPages }).`
    : "";
  return `apinoa.${o.platform}.${o.method}(params) → ${o.returns}   [${price(o.cost)} per call]\n  params:\n${params || "    (none)"}${paging}`;
}

export function searchDocs(ops: Operation[], query = "", platform?: string, limit = 6): string {
  const q = words(query);
  const typeAsked = query.match(/\b([A-Z][A-Za-z]+)\b/g)?.filter((t) => TYPE_NAMES.has(t)) ?? [];
  let pool = platform ? ops.filter((o) => o.platform === platform.toLowerCase()) : ops;
  if (platform && !pool.length) return `No platform "${platform}". Platforms: ${[...new Set(ops.map((o) => o.platform))].join(", ")}.`;
  // A query that names platforms is about those platforms only.
  const named = new Set(q.map((w) => (w === "twitter" ? "x" : w === "yt" ? "youtube" : w)).filter((w) => pool.some((o) => o.platform === w)));
  if (!platform && named.size) pool = pool.filter((o) => named.has(o.platform));
  if (!q.length && !platform && !typeAsked.length) return overview(ops);
  let picked = pool;
  if (q.length) {
    const ranked = pool.map((o) => ({ o, s: score(o, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    picked = ranked.slice(0, platform ? Math.max(limit, 8) : limit).map((x) => x.o);
  }
  if (!picked.length && !typeAsked.length) return `Nothing matched "${query}".\n\n${overview(ops)}`;
  const types = typesFor([...typeAsked, ...new Set(picked.map((o) => o.returns))]);
  return [
    picked.map(describe).join("\n\n"),
    types ? `Types the calls return (fields not listed here do not exist; ext holds platform-only extras as unknown):\n${types}` : "",
  ].filter(Boolean).join("\n\n");
}

export function overview(ops: Operation[]): string {
  const byPlatform = new Map<string, string[]>();
  for (const o of ops) byPlatform.set(o.platform, [...(byPlatform.get(o.platform) ?? []), o.method]);
  return [
    "Operations (call search_docs with words or a platform for parameters, costs and the fields returned):",
    ...[...byPlatform].map(([p, m]) => `- apinoa.${p}: ${m.join(", ")}`),
    "",
    "Helpers inside execute: pages(op, params, { maxPages }) follows cursors; many(items, fn, { concurrency }) fans out; store.save/load/list/saveFile keep data on this machine between runs; usage shows this run's units.",
  ].join("\n");
}
