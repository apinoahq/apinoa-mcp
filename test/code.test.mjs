// Code mode through a real MCP client: search_docs, and execute running code in the Deno sandbox against a fake
// API on a local port (the sandbox makes real HTTP requests, so the API cannot be faked at fetch here).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApinoaServer } from "../dist/server.js";

const CATALOG = [
  {
    id: "tiktok",
    kind: "sns",
    operations: ["profile", "posts", "comments", "media"],
    cost: { profile: { base: 1, max: 1 }, posts: { base: 1, max: 2 }, comments: { base: 1, max: 1 }, media: { base: 2, max: 2 } },
    params: {
      profile: { properties: { username: { type: "string", description: "Creator @handle." } } },
      posts: { properties: { username: { type: "string" }, hashtag: { type: "string", description: "Videos under a hashtag." }, limit: { type: "integer" }, cursor: { type: "string" } } },
      comments: { properties: { post: { type: "string" }, limit: { type: "integer" }, cursor: { type: "string" } } },
      media: { properties: { post: { type: "string" } } },
    },
  },
  {
    id: "amazon",
    kind: "marketplace",
    operations: ["search", "image-search"],
    cost: { search: { base: 1, max: 2 }, "image-search": { base: 1, max: 2 } },
    params: {
      search: { properties: { query: { type: "string" }, page: { type: "integer" } }, required: ["query"] },
      "image-search": { properties: { image: { type: "object" }, query: { type: "string" } }, required: ["image"] },
    },
  },
];

let api;
let baseUrl;
let calls = [];
let routes = {};

before(async () => {
  api = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, "http://x");
    const call = { method: req.method, url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    const route = routes[`${req.method} ${url.pathname}`];
    const [status, body, headers = {}] = route ? route(call) : [404, { success: false, error: { code: "NOT_FOUND", message: "no route" } }];
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": Buffer.isBuffer(body) ? "image/png" : "application/json", ...headers });
    res.end(bytes);
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

const ok = (data, cost = 1) => () => [200, { success: true, data }, { "x-apinoa-cost": String(cost) }];
const post = (id, views, extra = {}) => ({ platform: "tiktok", id, url: `https://www.tiktok.com/@a/video/${id}`, author: { platform: "tiktok", handle: "a" }, media: [], metrics: { views }, ...extra });

async function connect(opts = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), "apinoa-mcp-test-")));
  const server = await createApinoaServer({ apiKey: "ak_test", baseUrl, catalog: CATALOG, mode: "code", ...opts, sandbox: { dataDir, ...opts.sandbox } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dataDir };
}

const run = async (client, code, extra = {}) => {
  const res = await client.callTool({ name: "execute", arguments: { code, ...extra } }, undefined, { timeout: 120_000 });
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};
const fresh = (r = {}) => {
  calls = [];
  routes = r;
};

test("code mode serves search_docs, execute and translate_image, and says how to use them", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["execute", "search_docs", "translate_image"]);
  const execute = tools.find((t) => t.name === "execute");
  assert.match(execute.description, /apinoa\.tiktok: profile, posts, comments, media/);
  assert.match(execute.description, /type-checked before it runs/);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.match(client.getInstructions(), /search_docs/);
});

test("search_docs finds the operations for a task, with parameters, cost, paging and the fields returned", async () => {
  const { client } = await connect();
  const text = (await client.callTool({ name: "search_docs", arguments: { query: "tiktok hashtag videos" } })).content[0].text;
  assert.match(text, /apinoa\.tiktok\.posts\(params\) → PostPage {3}\[1–2 units per call\]/);
  assert.match(text, /hashtag\?: string — Videos under a hashtag\./);
  assert.match(text, /Next page: apinoa\.tiktok\.posts\(\{ cursor \}\)/);
  assert.match(text, /interface Post \{/);
  assert.doesNotMatch(text, /apinoa\.amazon/, "a query naming a platform stays on it");
  const all = (await client.callTool({ name: "search_docs", arguments: {} })).content[0].text;
  assert.match(all, /- apinoa\.amazon: search, imageSearch/);
});

test("execute runs the code against the API with the key, and returns only the result and the usage", async () => {
  fresh({ "GET /v1/tiktok/posts": ok({ platform: "tiktok", items: [post("1", 10), post("2", 300), post("3", 20)] }, 2) });
  const { client } = await connect();
  const r = await run(client, `const page = await apinoa.tiktok.posts({ username: "a", limit: 30 });
return page.items.map((p) => p.metrics?.views ?? 0).sort((a, b) => b - a)[0];`);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Returned:\n300/);
  assert.match(r.text, /\[apinoa: 1 call, 2 of 500 units \(\$0\.002\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], "ak_test");
  assert.equal(calls[0].url.searchParams.get("username"), "a");
  assert.equal(calls[0].url.searchParams.get("limit"), "30");
});

test("code that names an operation, parameter or field that does not exist fails the type check, before any call", async () => {
  fresh({ "GET /v1/tiktok/posts": ok({ items: [] }) });
  const { client } = await connect();
  const method = await run(client, `return await apinoa.tiktok.postz({ username: "a" });`);
  assert.equal(method.isError, true);
  assert.match(method.text, /did not type-check, so nothing ran and nothing was billed/);
  assert.match(method.text, /line 1: Property 'postz' does not exist/);
  const field = await run(client, `const p = await apinoa.tiktok.posts({ hashtags: "x" });\nreturn p.items[0].views;`);
  assert.match(field.text, /line 1: .*'hashtags' does not exist/);
  assert.match(field.text, /line 2: Property 'views' does not exist on type 'Post'/);
  assert.equal(calls.length, 0);
});

test("a refusal throws ApinoaError with its code and the line it came from", async () => {
  fresh({ "GET /v1/tiktok/profile": () => [404, { success: false, error: { code: "NOT_FOUND", message: "no such account" } }] });
  const { client } = await connect();
  const r = await run(client, `const x = 1;\nreturn await apinoa.tiktok.profile({ username: "nobody" });`);
  assert.equal(r.isError, true);
  assert.match(r.text, /Error \(line 2\): NOT_FOUND: no such account/);
  const caught = await run(client, `try { await apinoa.tiktok.profile({ username: "nobody" }); } catch (e) { return e instanceof ApinoaError ? e.code : "?"; }`);
  assert.match(caught.text, /Returned:\n"NOT_FOUND"/);
});

test("the run stops once its budget is spent", async () => {
  fresh({ "GET /v1/tiktok/profile": (c) => [200, { success: true, data: { handle: c.url.searchParams.get("username") } }, { "x-apinoa-cost": "1" }] });
  const { client } = await connect();
  const r = await run(client, `return await many(["a", "b", "c", "d", "e"], (u) => apinoa.tiktok.profile({ username: u }), { concurrency: 1 });`, { budget_units: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /BUDGET_EXCEEDED: the run's budget of 2 units is spent/);
  assert.equal(calls.length, 2);
});

test("pages follows cursors; many fans out and counts the items that failed", async () => {
  fresh({
    "GET /v1/tiktok/posts": (c) => {
      const cur = c.url.searchParams.get("cursor");
      if (!cur) return [200, { success: true, data: { items: [post("1", 1), post("2", 2)], cursor: "c2" } }];
      if (cur === "c2") return [200, { success: true, data: { items: [post("3", 3)], cursor: "c3" } }];
      return [200, { success: true, data: { items: [] } }];
    },
    "GET /v1/tiktok/profile": (c) => (c.url.searchParams.get("username") === "bad" ? [400, { success: false, error: { code: "INVALID_PARAMS", message: "bad handle" } }] : [200, { success: true, data: { handle: "ok" } }]),
  });
  const { client } = await connect();
  const r = await run(client, `const all = await pages(apinoa.tiktok.posts, { username: "a" }, { maxPages: 5 });
const prof = await many(["x", "bad", "y"], (u) => apinoa.tiktok.profile({ username: u }));
return { ids: all.map((p) => p.id), profiles: prof.map((p) => p?.handle ?? null) };`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text.match(/Returned:\n([\s\S]*?)\n\n\[apinoa/)[1]), { ids: ["1", "2", "3"], profiles: ["ok", null, "ok"] });
  assert.match(r.text, /1 failed \(INVALID_PARAMS: bad handle\)/);
  assert.equal(calls.filter((c) => c.url.pathname === "/v1/tiktok/posts").length, 3);
});

test("a repeated call is answered from the cache, free, and the store keeps data between runs", async () => {
  fresh({ "GET /v1/tiktok/profile": ok({ handle: "a", counts: { followers: 7 } }) });
  const { client } = await connect();
  const code = `const p = await apinoa.tiktok.profile({ username: "a" });\nawait store.save("followers", p.counts?.followers);\nreturn p.counts?.followers;`;
  await run(client, code);
  const again = await run(client, code);
  assert.match(again.text, /\[apinoa: 0 calls \+ 1 from cache, 0 of 500 units/);
  assert.equal(calls.length, 1);
  const loaded = await run(client, `return { n: await store.load("followers"), names: await store.list() };`);
  assert.match(loaded.text, /"n": 7/);
  assert.match(loaded.text, /"followers"/);
});

test("an image given by URL is downloaded by the server and sent as JSON", async () => {
  fresh({
    "GET /img.png": () => [200, Buffer.from([137, 80, 78, 71])],
    "POST /v1/amazon/image-search": ok({ items: [{ title: "Mug" }] }),
  });
  const { client } = await connect();
  const r = await run(client, `const res = await apinoa.amazon.imageSearch({ image: "${baseUrl}/img.png" });\nreturn res.items.map((i) => i.title);`);
  assert.equal(r.isError, false, r.text);
  const sent = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(sent.body), { image: { contentType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") } });
});

test("the sandbox reaches only the API: no other host, no files outside its data, no environment, no programs", async () => {
  fresh({});
  const { client } = await connect();
  const outside = join(await mkdtemp(join(tmpdir(), "outside-")), "secret.txt");
  await writeFile(outside, "secret");
  for (const [code, needs] of [
    [`return (await fetch("https://example.com")).status;`, /net access/],
    [`return await Deno.readTextFile(${JSON.stringify(outside)});`, /read access/],
    [`return Deno.env.get("HOME");`, /env access/],
    [`return new Deno.Command("ls").outputSync().code;`, /run access/],
    [`return await import("https://deno.land/std/fmt/colors.ts");`, /./],
  ]) {
    const r = await run(client, code);
    assert.equal(r.isError, true, code);
    assert.match(r.text, needs, code);
  }
});

test("code that replaces fetch never sees the API key", async () => {
  fresh({ "GET /v1/tiktok/profile": ok({ handle: "a" }) });
  const { client } = await connect();
  const r = await run(client, `let seen = "none";
const real = globalThis.fetch;
globalThis.fetch = (u, init) => { seen = JSON.stringify(init?.headers ?? {}); return real(u, init); };
await apinoa.tiktok.profile({ username: "a" });
return seen;`);
  assert.match(r.text, /Returned:\n"none"/);
  assert.doesNotMatch(r.text, /ak_test/);
});

test("output past the cap is cut with a note, and a run past its time is stopped", async () => {
  fresh({});
  const { client } = await connect({ sandbox: { maxOutputChars: 3000 } });
  const big = await run(client, `console.log("x".repeat(10000));\nreturn 1;`);
  assert.match(big.text, /…\[cut: 100\d\d characters, 3000 shown/);
  const slow = await run(client, `while (true) {}`, { timeout_seconds: 2 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /stopped after 2 s/);
});

test("without Deno the server serves the tool set, unless code mode was asked for by name", async () => {
  const server = await createApinoaServer({ apiKey: "ak_test", baseUrl, catalog: CATALOG, sandbox: { deno: "/nonexistent/deno" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("list_social_posts") && !names.includes("execute"));

  const { client: forced } = await connect({ sandbox: { deno: "/nonexistent/deno" } });
  const r = await run(forced, `return 1;`);
  assert.equal(r.isError, true);
  assert.match(r.text, /Code mode needs Deno/);
});
