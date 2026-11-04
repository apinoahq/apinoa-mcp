/**
 * The apinoa MCP server.
 *
 * Code mode (the default) exposes three tools: `search_docs` finds the operations for a task with their
 * parameters, costs and the fields they return; `execute` runs TypeScript the model writes against a typed
 * `apinoa` client in a sandbox, so a task of hundreds of calls is one tool call and only the result enters the
 * conversation; `translate_image` returns an image, which code cannot. APINOA_MCP_MODE=tools serves the 0.1
 * tool set instead (one tool call per API call).
 *
 * The platforms, operations and parameters come from the live catalog, so a platform added to apinoa appears
 * here without a new release.
 */
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchCatalog, translateImage, download, type ApiOptions, type CatalogEntry } from "./api.js";
import SNAPSHOT from "./catalog.snapshot.js";
import { declarations, operations, overview, sandboxOperations, searchDocs, type Operation } from "./code/docs.js";
import { Sandbox, denoRuns, findDeno, type SandboxOptions } from "./code/sandbox.js";
import { failure, registerLegacyTools } from "./legacy.js";

// The published package's own version (dist/ and src/ both sit one level below package.json), so a release
// cannot announce the previous one.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface ServerOptions {
  /** Defaults to APINOA_API_KEY. Docs work without one; every data call needs it. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Use this catalog instead of fetching the live one (tests, offline use). */
  catalog?: CatalogEntry[];
  /** The most characters one tool answer may carry before it is cut, to protect the model's context. */
  maxResultChars?: number;
  /** "code" (default) or "tools" (the 0.1 tool set). Defaults to APINOA_MCP_MODE. */
  mode?: "code" | "tools";
  /** Code mode: where the cache and store live, the deno binary, and the run limits. */
  sandbox?: Partial<Omit<SandboxOptions, "api" | "userAgent">>;
}

const DEFAULT_BUDGET = 500;

export async function createApinoaServer(options: ServerOptions = {}): Promise<McpServer> {
  const api: ApiOptions = {
    apiKey: options.apiKey ?? process.env.APINOA_API_KEY,
    baseUrl: (options.baseUrl ?? process.env.APINOA_BASE_URL ?? "https://gateway.apinoa.com").replace(/\/$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 300_000,
  };
  const maxChars = options.maxResultChars ?? 100_000;
  let catalog = options.catalog;
  if (!catalog) {
    try {
      catalog = await fetchCatalog(api);
    } catch {
      catalog = SNAPSHOT as CatalogEntry[];
    }
  }
  const asked = options.mode ?? (process.env.APINOA_MCP_MODE === "tools" ? "tools" : process.env.APINOA_MCP_MODE === "code" ? "code" : undefined);
  // Code mode needs Deno, which the package installs for the platforms Deno ships for. Elsewhere, unless code
  // mode was asked for by name, the server serves the tool set instead of a code tool that cannot run.
  let mode: "code" | "tools" = asked ?? "code";
  if (!asked && !denoRuns(findDeno(options.sandbox?.deno))) {
    mode = "tools";
    console.error("apinoa-mcp: Deno was not found, so the per-operation tools are served instead of code mode. Install Deno (https://deno.com) or set APINOA_MCP_DENO to use code mode.");
  }

  const server = new McpServer(
    { name: "apinoa", version: VERSION },
    {
      instructions:
        about(catalog) +
        (mode === "code"
          ? " Find the operations and fields with search_docs, then call them from TypeScript in execute: fan out, page, filter and aggregate in the code, and return only the result."
          : " Products: search_products, get_product, get_product_reviews, list_categories, browse_category. Social: get_social_profile, list_social_posts, get_social_post, get_social_comments. " +
            "Search results and AI answers: call_apinoa with a platform (google, bing, naver, chatgpt, gemini…) and its operation (search, answer…); list_platforms lists every operation and its parameters. " +
            "translate_image translates the text in a product photo."),
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  if (mode === "tools") registerLegacyTools(server, api, catalog, maxChars);
  else registerCodeTools(server, api, operations(catalog), options);

  server.registerTool(
    "translate_image",
    {
      title: "Translate the text in an image",
      description:
        "Replace the text inside a product image with a translation, keeping fonts, colours and layout. Give the image as a URL. Returns the translated image.",
      inputSchema: {
        image_url: z.string().url().describe("An http(s) URL of a JPEG, PNG or WebP image."),
        source_language: z.enum(["auto", "ch", "zh", "zh-CN", "zh-TW", "chinese_cht", "ja", "japan", "en"]).describe("The language of the text in the image, or auto."),
        target_language: z.string().min(2).max(8).describe("The language to translate into, e.g. ko, en, ja, zh-CN."),
        font: z.string().optional().describe("A font name from supported fonts. Default Pretendard."),
      },
      annotations: { title: "Translate the text in an image", ...readOnly },
    },
    async (args: any) => {
      try {
        const img = await download(api, args.image_url);
        const out = await translateImage(api, img.bytes, img.contentType, {
          source_language: args.source_language,
          target_language: args.target_language,
          font: args.font,
        });
        if (out.contentType.startsWith("image/")) {
          return {
            content: [
              { type: "image", data: Buffer.from(out.bytes).toString("base64"), mimeType: out.contentType },
              { type: "text", text: `Translated ${out.regions ?? "the"} text region${out.regions === 1 ? "" : "s"}.` },
            ],
          };
        }
        return { content: [{ type: "text", text: new TextDecoder().decode(out.bytes) }] };
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}

/** Display names for the sources the server introduces itself with; an id without one is shown as it is. */
const NAMES: Record<string, string> = {
  amazon: "Amazon", walmart: "Walmart", shopify: "Shopify", tiktokshop: "TikTok Shop", aliexpress: "AliExpress", ebay: "eBay",
  tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", reddit: "Reddit", x: "X", threads: "Threads", linkedin: "LinkedIn",
  google: "Google", bing: "Bing", naver: "Naver", baidu: "Baidu", yandex: "Yandex", yahoo: "Yahoo",
  chatgpt: "ChatGPT", gemini: "Gemini", "google-aio": "Google AI Overviews", "google-ai-mode": "Google AI Mode",
  "naver-ai-brief": "Naver AI Briefing", "naver-ai-tab": "Naver AI Tab",
};
const SNS = new Set(["tiktok", "instagram", "youtube", "reddit", "x", "threads", "linkedin"]);
const ORDER = Object.keys(NAMES);
const byOrder = (a: string, b: string) => (ORDER.indexOf(a) + 1 || 999) - (ORDER.indexOf(b) + 1 || 999);
const list = (ids: string[]) => {
  const names = ids.sort(byOrder).map((id) => NAMES[id] ?? id);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
};

/**
 * The first thing a client reads about the server, so it names what a developer would type — the sources, by
 * name — before any tool. Built from the catalog the server serves, so a source appears here when it is served
 * and not before.
 */
export function about(catalog: CatalogEntry[]): string {
  const kind = (e: CatalogEntry) => (e as { kind?: string }).kind ?? (SNS.has(e.id) ? "sns" : "marketplace");
  const of = (k: string) => catalog.filter((e) => kind(e) === k).map((e) => e.id);
  const serp = of("serp");
  const named = serp.filter((id) => ["google", "bing", "naver", "baidu", "yandex", "yahoo"].includes(id));
  const parts = [
    of("marketplace").length && `${list(of("marketplace"))} products, reviews and categories`,
    of("sns").length && `${list(of("sns"))} posts, profiles and comments`,
    serp.length && `search results from ${named.sort(byOrder).map((id) => NAMES[id]).join(", ")}${serp.length > named.length ? ` and ${serp.length - named.length} more search engines` : ""}`,
    of("answers").length && `what ${list(of("answers"))} ${of("answers").length > 1 ? "answer" : "answers"} to a prompt, with the citations`,
  ].filter(Boolean) as string[];
  return `apinoa returns live web data as JSON: ${parts.join("; ")}. Use it instead of writing a scraper.`;
}

const EXAMPLE = `const page = await apinoa.tiktok.posts({ hashtag: "glassskin", limit: 50 });
const authors = [...new Set(page.items.map((p) => p.author.handle))].slice(0, 10);
const recent = await many(authors, (u) => apinoa.tiktok.posts({ username: u, limit: 30 }));
return authors.map((u, i) => {
  const views = (recent[i]?.items ?? []).map((p) => p.metrics?.views ?? 0).sort((a, b) => a - b);
  return { author: u, median: views[Math.floor(views.length / 2)] ?? null };
});`;

function registerCodeTools(server: McpServer, api: ApiOptions, ops: Operation[], options: ServerOptions) {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  const sandbox = new Sandbox({ ...options.sandbox, api, userAgent: `apinoa-mcp/${VERSION} (code)` }, declarations(ops), sandboxOperations(ops));
  const maxBudget = Number(process.env.APINOA_MCP_MAX_BUDGET ?? 20_000);
  const platforms = [...new Set(ops.map((o) => o.platform))];

  server.registerTool(
    "search_docs",
    {
      title: "Search the apinoa docs",
      description:
        "Find how to do a task with apinoa: the matching operations as you call them in execute (e.g. apinoa.tiktok.posts({ hashtag })), every parameter, the cost per call, and the fields of what they return. " +
        "Free: it calls nothing. Use it before writing code. Pass words ('tiktok hashtag videos', 'instagram reels of an account', 'amazon product reviews'), a platform, or a type name ('Post'); with neither you get the list of every operation.\n\n" +
        `Platforms: ${platforms.join(", ")}.`,
      inputSchema: {
        query: z.string().optional().describe("What you want to do or read, in a few words, or a type name."),
        platform: z.string().optional().describe("Only this platform's operations."),
      },
      annotations: { title: "Search the apinoa docs", readOnlyHint: true, openWorldHint: false },
    },
    async (args: any) => ({ content: [{ type: "text", text: searchDocs(ops, args.query ?? "", args.platform) }] }),
  );

  server.registerTool(
    "execute",
    {
      title: "Run code against apinoa",
      description: [
        "Run TypeScript that calls the apinoa API, and get back only what it prints or returns. Use it for every data task, from one call to thousands: fan out over accounts or posts, follow pages, then filter, count, rank and average in the code, so raw API answers never fill the conversation.",
        "",
        "The code is the body of an async function: use await, and `return` a small result (aggregate, slice, pick the fields you need). In scope:",
        "- apinoa.<platform>.<operation>(params): one API call, returns the answer's data; throws ApinoaError (code, status) on a refusal. search_docs lists the parameters and the fields returned.",
        "- pages(op, params, { maxPages }): every item of a paged operation, following cursors (default 5 pages).",
        "- many(items, fn, { concurrency }): fn over every item, 8 at a time by default; a failed item comes back undefined.",
        "- store.save(name, value) / store.load(name) / store.list() / store.saveFile(name, base64): data kept on this machine between runs.",
        "- usage: { calls, units, budget } of this run.",
        "The code is type-checked before it runs: an operation, parameter or field that does not exist fails there, before anything is billed.",
        "Each call costs units (1 unit = $0.001, per search_docs); the run stops once budget_units are spent. Answers are cached for 10 minutes, so re-running after a fix costs nothing for calls already made. Only the API is reachable from the code.",
        "",
        "Example:",
        EXAMPLE,
        "",
        overview(ops).split("\n\nHelpers")[0],
      ].join("\n"),
      inputSchema: {
        code: z.string().min(1).describe("TypeScript: the body of an async function. Return the result."),
        budget_units: z.number().int().positive().max(maxBudget).optional().describe(`Most units this run may spend (default ${DEFAULT_BUDGET}, at most ${maxBudget}).`),
        timeout_seconds: z.number().int().positive().max(1800).optional().describe("Stop the run after this long (default 300)."),
      },
      annotations: { title: "Run code against apinoa", ...readOnly },
    },
    async (args: any, extra: any) => {
      const token = extra?._meta?.progressToken;
      const onProgress =
        token === undefined
          ? undefined
          : (s: { calls: number; units: number }) => {
              Promise.resolve(
                extra.sendNotification?.({ method: "notifications/progress", params: { progressToken: token, progress: s.calls, message: `${s.calls} calls, ${s.units} units` } }),
              ).catch(() => {});
            };
      const run = await sandbox.run(args.code, args.budget_units ?? DEFAULT_BUDGET, (args.timeout_seconds ?? 300) * 1000, onProgress);
      return { content: [{ type: "text", text: run.text }], ...(run.ok ? {} : { isError: true }) };
    },
  );
}
