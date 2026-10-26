/**
 * The 0.1 tool set (APINOA_MCP_MODE=tools): a handful of tools named by intent, each one API call, each taking
 * a `platform`. Kept for clients that cannot run code mode; code mode is the default.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ApiError, callOperation, download, type ApiOptions, type CatalogEntry } from "./api.js";

/** Operations whose answer is a file, not data: reachable through the API, the SDKs and code mode, not as tool text. */
const FILE_OPERATIONS = new Set(["tiktok/media"]);

interface ToolSpec {
  name: string;
  title: string;
  /** The catalog operation this tool calls. */
  operation: string;
  summary: string;
  /** The one input every platform takes for this operation, lifted out of `params` for the model. */
  primary?: { name: string; description: string; required: boolean };
  paging?: string;
}

const TOOLS: ToolSpec[] = [
  {
    name: "search_products",
    title: "Search products",
    operation: "search",
    summary: "Search a marketplace's products by keyword. Returns a SearchResult: items with title, price, rating, seller and url.",
    primary: { name: "query", description: "Keywords to search for.", required: true },
    paging: "For the next page pass params.page = 2, 3, … (or params.cursor where the platform returns one).",
  },
  {
    name: "get_product",
    title: "Get a product",
    operation: "product",
    summary: "One product in full: variants, images, specifications, seller, delivery and price.",
    primary: { name: "id", description: "The product id as the platform's search results carry it (an ASIN, a numeric id, shop/handle…), or its URL where accepted.", required: true },
  },
  {
    name: "get_product_reviews",
    title: "Get product reviews",
    operation: "reviews",
    summary: "A product's reviews, one page at a time.",
    primary: { name: "id", description: "The product id, as get_product takes it.", required: true },
    paging: "For the next page pass params.page or params.cursor as the previous answer indicates.",
  },
  {
    name: "list_categories",
    title: "List categories",
    operation: "categories",
    summary: "One level of a marketplace's category tree. Omit params.categoryId for the top level; pass an id for its children. Ids feed browse_category.",
  },
  {
    name: "browse_category",
    title: "Browse a category",
    operation: "browse",
    summary: "The products in one category, with no keyword. Get category ids from list_categories.",
    paging: "For the next page pass params.page = 2, 3, …",
  },
  {
    name: "get_social_profile",
    title: "Get a social profile",
    operation: "profile",
    summary: "One account on a social platform: name, bio, follower counts, verification, links.",
    primary: { name: "username", description: "The handle, with or without @, or the profile URL.", required: false },
  },
  {
    name: "list_social_posts",
    title: "List social posts",
    operation: "posts",
    summary:
      "Posts from a social platform. What you pass in params picks the source: an account's (username), a search (query), a hashtag, community, sound, company, playlist, posts related to one (relatedTo) — or nothing for the trending feed.",
    paging: "For the next page call again with params = { cursor } alone, using the cursor of the previous answer.",
  },
  {
    name: "get_social_post",
    title: "Get a social post",
    operation: "post",
    summary: "One post: text, author, media, counts, time.",
    primary: { name: "id", description: "The post id or shortcode, or its URL.", required: true },
  },
  {
    name: "get_social_comments",
    title: "Get comments",
    operation: "comments",
    summary: "A post's comments (params.post), one comment's replies (params.comment), or an account's comments.",
    paging: "For the next page call again with params = { cursor } alone.",
  },
];

function describePlatform(e: CatalogEntry, operation: string): string {
  const schema = e.params[operation];
  const props = Object.keys(schema?.properties ?? {});
  const required = new Set(schema?.required ?? []);
  const cost = e.cost?.[operation];
  const price = cost ? (cost.base === cost.max ? ` [${cost.base} unit${cost.base === 1 ? "" : "s"}]` : ` [${cost.base}–${cost.max} units]`) : "";
  return `- ${e.id}${price}: ${props.map((p) => (required.has(p) ? `${p}*` : p)).join(", ") || "(no parameters)"}`;
}

/**
 * A social post's media lists every rendition of each file (sizes, bitrates): on Threads that is three
 * quarters of a search answer. The model needs one, so each media keeps its main url, thumbnail and size,
 * and its `variants` are left out. Only media's: a product's `variants` (sizes, colours) are data.
 */
function withoutRenditions(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(withoutRenditions);
  if (data === null || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] =
      k === "media" && Array.isArray(v)
        ? v.map((m) => {
            if (m === null || typeof m !== "object") return m;
            const { variants: _renditions, ...rest } = m as Record<string, unknown>;
            return withoutRenditions(rest);
          })
        : withoutRenditions(v);
  }
  return out;
}

function result(raw: unknown, maxChars: number): CallToolResult {
  const data = withoutRenditions(raw);
  const text = JSON.stringify(data);
  if (text.length <= maxChars) return { content: [{ type: "text", text }] };

  // Too large: keep whole items, so the answer stays valid JSON — as many as fit, then say what is missing.
  const items = (data as { items?: unknown })?.items;
  if (Array.isArray(items) && items.length > 1) {
    const page = (n: number) => JSON.stringify({ ...(data as object), items: items.slice(0, n) });
    let lo = 1;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (page(mid).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    if (page(lo).length <= maxChars) {
      return {
        content: [
          { type: "text", text: page(lo) },
          {
            type: "text",
            text: `Showing ${lo} of the ${items.length} items on this page: the whole page is ${text.length} characters, over the ${maxChars} limit. For the other ${items.length - lo}, ask again with a smaller params.limit where the platform takes one, or a narrower query.`,
          },
        ],
      };
    }
  }
  return {
    content: [{ type: "text", text: `${text.slice(0, maxChars)}\n…[cut at ${maxChars} of ${text.length} characters; ask for fewer items (params.limit) or a narrower query]` }],
  };
}

export function failure(e: unknown): CallToolResult {
  const text =
    e instanceof ApiError
      ? `${e.message}${e.requestId ? ` (requestId ${e.requestId})` : ""}${e.status === 402 ? " — the apinoa balance is used up; top up at https://apinoa.com/dashboard/balance" : ""}${e.status === 401 ? " — set APINOA_API_KEY to a key from https://apinoa.com/dashboard" : ""}`
      : `apinoa: ${e instanceof Error ? e.message : String(e)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** Registers the 0.1 tools on `server`. */
export function registerLegacyTools(server: McpServer, api: ApiOptions, catalog: CatalogEntry[], maxChars: number) {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  // Answers are already cut to maxChars here; this asks Claude Code to keep them in the conversation up to that
  // size instead of moving them to a file the model may have no tool to read.
  const _meta = { "anthropic/maxResultSizeChars": maxChars + 2000 };

  for (const spec of TOOLS) {
    const platforms = catalog.filter((e) => e.operations.includes(spec.operation)).map((e) => e.id);
    if (platforms.length === 0) continue;
    const lines = catalog.filter((e) => platforms.includes(e.id)).map((e) => describePlatform(e, spec.operation));
    const description = [
      spec.summary,
      "",
      `Platforms and the params each accepts (* = required${spec.primary ? `; ${spec.primary.name} may be given at the top level` : ""}):`,
      ...lines,
      ...(spec.paging ? ["", spec.paging] : []),
      "",
      "Costs are in units of $0.001 at list price; a call that fails is not billed.",
    ].join("\n");
    const shape: Record<string, z.ZodTypeAny> = {
      platform: z.enum(platforms as [string, ...string[]]).describe("Which platform to read."),
    };
    if (spec.primary) {
      const field = z.string().min(1).describe(spec.primary.description);
      shape[spec.primary.name] = spec.primary.required ? field : field.optional();
    }
    shape.params = z.record(z.unknown()).optional().describe("The platform's other parameters, by the names listed above.");

    server.registerTool(spec.name, { title: spec.title, description, inputSchema: shape, annotations: { title: spec.title, ...readOnly }, _meta }, async (args: any) => {
      try {
        const params: Record<string, unknown> = { ...(args.params ?? {}) };
        if (spec.primary && args[spec.primary.name] !== undefined) params[spec.primary.name] = args[spec.primary.name];
        return result(await callOperation(api, args.platform, spec.operation, params), maxChars);
      } catch (e) {
        return failure(e);
      }
    });
  }

  const imagePlatforms = catalog.filter((e) => e.operations.includes("image-search")).map((e) => e.id);
  if (imagePlatforms.length) server.registerTool(
    "search_products_by_image",
    {
      title: "Search products by image",
      description:
        "Find a marketplace's products that match a photo. Give the photo as a URL; it is downloaded and sent as the search image.\n\nPlatforms: " +
        imagePlatforms.join(", "),
      inputSchema: {
        platform: z.enum(imagePlatforms as [string, ...string[]]).describe("Which marketplace to search."),
        image_url: z.string().url().describe("An http(s) URL of a JPEG or PNG photo."),
        params: z.record(z.unknown()).optional().describe("Other parameters of the platform's image-search (region, filters)."),
      },
      annotations: { title: "Search products by image", ...readOnly },
      _meta,
    },
    async (args: any) => {
      try {
        const img = await download(api, args.image_url);
        const data = Buffer.from(img.bytes).toString("base64");
        return result(await callOperation(api, args.platform, "image-search", { ...(args.params ?? {}), image: { contentType: img.contentType, data } }), maxChars);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "call_apinoa",
    {
      title: "Call any apinoa operation",
      description: [
        "Call any operation of the apinoa API directly, for what the other tools do not cover (store catalogs, shipping quotes, groups, followers, LinkedIn jobs…).",
        "Every platform and its operations (params of each are listed by list_platforms):",
        ...catalog.map((e) => `- ${e.id}: ${e.operations.filter((op) => !FILE_OPERATIONS.has(`${e.id}/${op}`)).join(", ")}`),
      ].join("\n"),
      inputSchema: {
        platform: z.string().describe("Platform id, e.g. amazon, reddit."),
        operation: z.string().describe("Operation as written in the list, e.g. search, image-search, groups."),
        params: z.record(z.unknown()).optional().describe("The operation's parameters."),
      },
      annotations: { title: "Call any apinoa operation", ...readOnly },
      _meta,
    },
    async (args: any) => {
      if (FILE_OPERATIONS.has(`${args.platform}/${args.operation}`)) {
        return failure(new ApiError(400, "FILE_OPERATION", `${args.platform}/${args.operation} returns a file; use the apinoa SDK or API for it`));
      }
      try {
        return result(await callOperation(api, args.platform, args.operation, args.params ?? {}), maxChars);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "list_platforms",
    {
      title: "List platforms",
      description: "Every platform apinoa serves, its operations, what each costs, and the parameters each operation accepts. Free, and needs no key.",
      inputSchema: {
        platform: z.string().optional().describe("Only this platform's details."),
      },
      annotations: { title: "List platforms", ...readOnly },
    },
    async (args: any) => {
      const entries = catalog.filter((e) => !args.platform || e.id === args.platform);
      const text = entries
        .map((e) =>
          [`## ${e.id} (${e.kind})${e.regions?.length ? ` — regions: ${e.regions.join(", ")}` : ""}`, ...e.operations.map((op) => describePlatform(e, op).replace(`- ${e.id}`, `- ${op}`))].join("\n"),
        )
        .join("\n\n");
      return { content: [{ type: "text", text: text || `no platform ${args.platform}` }] };
    },
  );
}
