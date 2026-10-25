// The server through a real MCP client over an in-memory transport, with the API faked at fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApinoaServer } from "../dist/server.js";

const CATALOG = [
  {
    id: "walmart",
    kind: "marketplace",
    operations: ["search", "product", "reviews"],
    cost: { search: { base: 1, max: 1 }, product: { base: 1, max: 1 }, reviews: { base: 1, max: 1 } },
    params: {
      search: { properties: { query: {}, page: {}, priceMax: {} }, required: ["query"] },
      product: { properties: { id: {} }, required: ["id"] },
      reviews: { properties: { id: {}, page: {} }, required: ["id"] },
    },
  },
  {
    id: "amazon",
    kind: "marketplace",
    operations: ["search", "image-search"],
    params: { search: { properties: { query: {}, brands: {} }, required: ["query"] }, "image-search": { properties: { image: {} }, required: ["image"] } },
  },
  {
    id: "tiktok",
    kind: "sns",
    operations: ["profile", "posts", "media"],
    params: { profile: { properties: { username: {} } }, posts: { properties: { username: {}, cursor: {} } }, media: { properties: { post: {} } } },
  },
];

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const handler = routes[`${init.method ?? "GET"} ${u.pathname}`] ?? routes[u.href] ?? (() => [404, { success: false, error: { code: "NOT_FOUND", message: "no route" } }]);
    const [status, body, headers = {}] = handler(u, init);
    const isBytes = body instanceof Uint8Array;
    return new Response(isBytes ? body : JSON.stringify(body), { status, headers: { "content-type": isBytes ? "image/jpeg" : "application/json", ...headers } });
  };
  fn.calls = calls;
  return fn;
}

async function connect(opts) {
  const server = await createApinoaServer({ apiKey: "ak_test", baseUrl: "https://api.test", timeoutMs: 5000, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("tools are named by intent, and each lists only the platforms that have its operation", async () => {
  const client = await connect({ catalog: CATALOG, fetch: fakeFetch({}) });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["call_apinoa", "get_product", "get_product_reviews", "get_social_profile", "list_platforms", "list_social_posts", "search_products", "search_products_by_image", "translate_image"]);
  const search = tools.find((t) => t.name === "search_products");
  assert.deepEqual(search.inputSchema.properties.platform.enum, ["walmart", "amazon"]);
  assert.match(search.description, /- walmart \[1 unit\]: query\*, page, priceMax/);
  assert.deepEqual(search.inputSchema.required.sort(), ["platform", "query"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
});

test("search_products sends a GET with the key, the query and the extra params", async () => {
  const fetch = fakeFetch({ "GET /v1/walmart/search": () => [200, { success: true, data: { items: [{ title: "Socks" }] } }] });
  const client = await connect({ catalog: CATALOG, fetch });
  const res = await client.callTool({ name: "search_products", arguments: { platform: "walmart", query: "wool socks", params: { page: 2, brands: ["a", "b"] } } });
  const [call] = fetch.calls;
  assert.equal(call.method, "GET");
  assert.equal(call.url.searchParams.get("query"), "wool socks");
  assert.equal(call.url.searchParams.get("page"), "2");
  assert.equal(call.url.searchParams.get("brands"), "a,b");
  assert.equal(call.headers["x-api-key"], "ak_test");
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), { items: [{ title: "Socks" }] });
});

test("an API refusal comes back as a tool error naming the code, with a hint for 402", async () => {
  const fetch = fakeFetch({ "GET /v1/walmart/product": () => [402, { success: false, error: { code: "INSUFFICIENT_BALANCE", message: "top up" }, requestId: "r9" }] });
  const client = await connect({ catalog: CATALOG, fetch });
  const res = await client.callTool({ name: "get_product", arguments: { platform: "walmart", id: "1" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /INSUFFICIENT_BALANCE: top up \(requestId r9\).*balance/);
  assert.equal(fetch.calls.length, 1, "402 is not retried");
});

test("a 429 is retried after Retry-After", async () => {
  let n = 0;
  const fetch = fakeFetch({
    "GET /v1/tiktok/profile": () => (++n === 1 ? [429, { success: false, error: { code: "CAPACITY_SATURATED", message: "busy" } }, { "retry-after": "0" }] : [200, { success: true, data: { handle: "nasa" } }]),
  });
  const client = await connect({ catalog: CATALOG, fetch });
  const res = await client.callTool({ name: "get_social_profile", arguments: { platform: "tiktok", username: "nasa" } });
  assert.equal(JSON.parse(res.content[0].text).handle, "nasa");
  assert.equal(fetch.calls.length, 2);
});

test("search by image downloads the URL and posts it as base64", async () => {
  const fetch = fakeFetch({
    "https://img.test/a.png": () => [200, new Uint8Array([137, 80, 78, 71]), { "content-type": "image/png" }],
    "POST /v1/amazon/image-search": () => [200, { success: true, data: { items: [] } }],
  });
  const client = await connect({ catalog: CATALOG, fetch });
  const res = await client.callTool({ name: "search_products_by_image", arguments: { platform: "amazon", image_url: "https://img.test/a.png" } });
  assert.equal(res.isError, undefined);
  const post = fetch.calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { image: { contentType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") } });
});

test("call_apinoa reaches any operation but refuses one that returns a file", async () => {
  const fetch = fakeFetch({ "GET /v1/tiktok/posts": () => [200, { success: true, data: { items: [], cursor: "c2" } }] });
  const client = await connect({ catalog: CATALOG, fetch });
  const ok = await client.callTool({ name: "call_apinoa", arguments: { platform: "tiktok", operation: "posts", params: { cursor: "c1" } } });
  assert.equal(JSON.parse(ok.content[0].text).cursor, "c2");
  const media = await client.callTool({ name: "call_apinoa", arguments: { platform: "tiktok", operation: "media", params: { post: "1" } } });
  assert.equal(media.isError, true);
  assert.equal(fetch.calls.length, 1);
});

test("translate_image returns the translated picture as image content", async () => {
  const fetch = fakeFetch({
    "https://img.test/p.jpg": () => [200, new Uint8Array([0xff, 0xd8, 1]), { "content-type": "image/jpeg" }],
    "POST /v1/image-translate/translate": () => [200, new Uint8Array([0xff, 0xd8, 9]), { "x-apinoa-regions-count": "3" }],
  });
  const client = await connect({ catalog: CATALOG, fetch });
  const res = await client.callTool({ name: "translate_image", arguments: { image_url: "https://img.test/p.jpg", source_language: "zh-CN", target_language: "ko" } });
  const call = fetch.calls.find((c) => c.method === "POST");
  assert.equal(call.url.searchParams.get("target_language"), "ko");
  assert.equal(call.headers["content-type"], "image/jpeg");
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].data, Buffer.from([0xff, 0xd8, 9]).toString("base64"));
  assert.match(res.content[1].text, /3 text regions/);
});

test("an answer too large for the model's context keeps whole items, stays valid JSON, and says what is missing", async () => {
  const fetch = fakeFetch({ "GET /v1/walmart/search": () => [200, { success: true, data: { items: Array.from({ length: 500 }, (_, i) => ({ title: `item ${i}` })) } }] });
  const client = await connect({ catalog: CATALOG, fetch, maxResultChars: 1000 });
  const res = await client.callTool({ name: "search_products", arguments: { platform: "walmart", query: "x" } });
  const page = JSON.parse(res.content[0].text);
  assert.ok(res.content[0].text.length <= 1000);
  assert.ok(page.items.length > 1 && page.items.length < 500);
  assert.equal(page.items[0].title, "item 0");
  assert.match(res.content[1].text, new RegExp(`^Showing ${page.items.length} of the 500 items`));
});

test("an answer with no item list that is still too large is cut, and says so", async () => {
  const fetch = fakeFetch({ "GET /v1/walmart/product": () => [200, { success: true, data: { title: "x".repeat(5000) } }] });
  const client = await connect({ catalog: CATALOG, fetch, maxResultChars: 1000 });
  const res = await client.callTool({ name: "get_product", arguments: { platform: "walmart", id: "1" } });
  assert.match(res.content[0].text, /\[cut at 1000 of \d+ characters/);
});

test("a post's media keeps its main file but not every rendition; a product's variants stay", async () => {
  const media = [{ type: "video", url: "https://cdn/v.mp4", thumbnailUrl: "https://cdn/t.jpg", variants: [{ url: "https://cdn/v-720.mp4" }, { url: "https://cdn/v-360.mp4" }] }];
  const fetch = fakeFetch({
    "GET /v1/tiktok/posts": () => [200, { success: true, data: { items: [{ id: "1", media, quoteOf: { id: "0", media } }], cursor: "c2" } }],
    "GET /v1/walmart/product": () => [200, { success: true, data: { title: "Shoe", variants: [{ id: "v1", options: { size: "9" } }] } }],
  });
  const client = await connect({ catalog: CATALOG, fetch });
  const posts = JSON.parse((await client.callTool({ name: "list_social_posts", arguments: { platform: "tiktok", params: { username: "a" } } })).content[0].text);
  assert.deepEqual(posts.items[0].media, [{ type: "video", url: "https://cdn/v.mp4", thumbnailUrl: "https://cdn/t.jpg" }]);
  assert.equal(posts.items[0].quoteOf.media[0].variants, undefined, "nested posts too");
  assert.equal(posts.cursor, "c2");
  const product = JSON.parse((await client.callTool({ name: "get_product", arguments: { platform: "walmart", id: "1" } })).content[0].text);
  assert.deepEqual(product.variants, [{ id: "v1", options: { size: "9" } }]);
});

test("without a catalog the live one is read, and when it cannot be, the bundled snapshot is used", async () => {
  const live = fakeFetch({ "GET /v1/marketplaces": () => [200, { success: true, data: { marketplaces: CATALOG } }] });
  const a = await connect({ fetch: live });
  assert.ok((await a.listTools()).tools.some((t) => t.name === "search_products"));
  assert.equal(live.calls[0].url.pathname, "/v1/marketplaces");

  const down = fakeFetch({ "GET /v1/marketplaces": () => [503, { success: false, error: { code: "SERVICE_UNAVAILABLE", message: "down" } }] });
  const b = await connect({ fetch: down });
  const search = (await b.listTools()).tools.find((t) => t.name === "search_products");
  assert.ok(search.inputSchema.properties.platform.enum.includes("amazon"), "snapshot platforms");
});
