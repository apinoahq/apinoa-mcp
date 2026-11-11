// send_feedback / get_feedback: an agent reports a failed call, wrong or missing data, or a missing API, with or
// without a key, and reads our reply later. The API is faked at fetch; both tools exist in every mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApinoaServer } from "../dist/server.js";

const CATALOG = [{ id: "amazon", kind: "marketplace", operations: ["search"], params: { search: { properties: { query: {} }, required: ["query"] } } }];
const ID = "fb_0123456789abcdef0123456789abcdef";

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const handler = routes[`${init.method ?? "GET"} ${u.pathname}`] ?? (() => [404, { success: false, error: { code: "NOT_FOUND", message: "no route" } }]);
    const [status, body, headers = {}] = handler(u, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  fn.calls = calls;
  return fn;
}

async function connect(opts) {
  const server = await createApinoaServer({ apiKey: "ak_test", baseUrl: "https://api.test", timeoutMs: 5000, mode: "tools", catalog: CATALOG, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const receipt = () => [201, { success: true, data: { id: ID, status: "received", createdAt: "2026-11-11T10:00:00Z" } }];

test("send_feedback is offered, and says when to use it; get_feedback reads only", async () => {
  const { tools } = await (await connect({ fetch: fakeFetch({}) })).listTools();
  const send = tools.find((t) => t.name === "send_feedback");
  const get = tools.find((t) => t.name === "get_feedback");
  assert.ok(send && get);
  assert.match(send.description, /failed/);
  assert.match(send.description, /wrong or missing/);
  assert.match(send.description, /free/i);
  assert.match(send.description, /get_feedback/);
  assert.deepEqual(send.inputSchema.required.sort(), ["message", "type"]);
  assert.deepEqual(send.inputSchema.properties.type.enum, ["feature_request", "error", "wrong_data", "missing_data", "other"]);
  assert.equal(send.annotations.readOnlyHint, false);
  assert.equal(get.annotations.readOnlyHint, true);
});

test("send_feedback posts the report with no key when the server has none, as source mcp", async () => {
  const fetch = fakeFetch({ "POST /v1/feedback": receipt });
  const client = await connect({ apiKey: "", fetch });
  const res = await client.callTool({
    name: "send_feedback",
    arguments: {
      type: "wrong_data",
      message: "price is the list price",
      platform: "amazon",
      operation: "product",
      params: { asin: "B0" },
      request_id: "r1",
      received: '{"price":20}',
      expected: "18.99",
      contact: "dev@example.com",
    },
  });
  assert.equal(res.isError, undefined);
  const [call] = fetch.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url.pathname, "/v1/feedback");
  assert.equal(call.headers["x-api-key"], undefined);
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.body), {
    type: "wrong_data",
    message: "price is the list price",
    platform: "amazon",
    operation: "product",
    params: { asin: "B0" },
    requestId: "r1",
    received: '{"price":20}',
    expected: "18.99",
    contact: "dev@example.com",
    source: "mcp",
  });
  assert.match(res.content[0].text, new RegExp(ID));
  assert.match(res.content[0].text, /get_feedback/);
});

test("with a key, send_feedback sends it, so the report is linked to the account", async () => {
  const fetch = fakeFetch({ "POST /v1/feedback": receipt });
  await (await connect({ fetch })).callTool({ name: "send_feedback", arguments: { type: "feature_request", message: "Etsy, please" } });
  assert.equal(fetch.calls[0].headers["x-api-key"], "ak_test");
});

test("get_feedback reads the status and reply by id", async () => {
  const fetch = fakeFetch({
    [`GET /v1/feedback/${ID}`]: () => [200, { success: true, data: { id: ID, type: "error", status: "resolved", reply: "Fixed.", repliedAt: "2026-11-11T12:00:00Z", createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T12:00:00Z" } }],
  });
  const res = await (await connect({ apiKey: "", fetch })).callTool({ name: "get_feedback", arguments: { id: ID } });
  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(res.content[0].text).reply, "Fixed.");
});

test("a refusal comes back as the tool's error text at once, a 429 included", async () => {
  const fetch = fakeFetch({
    "POST /v1/feedback": () => [429, { success: false, error: { code: "RATE_LIMITED", message: "Too much feedback from this sender for now." } }, { "retry-after": "3600" }],
  });
  const started = Date.now();
  const res = await (await connect({ apiKey: "", fetch })).callTool({ name: "send_feedback", arguments: { type: "other", message: "x" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RATE_LIMITED/);
  assert.equal(fetch.calls.length, 1, "feedback is not retried: the agent is told and moves on");
  assert.ok(Date.now() - started < 2000);
});

test("received and expected may be the JSON values themselves, and go out as they are", async () => {
  const fetch = fakeFetch({ "POST /v1/feedback": receipt });
  const res = await (await connect({ apiKey: "", fetch })).callTool({
    name: "send_feedback",
    arguments: { type: "wrong_data", message: "wrong price", received: { price: { amount: 29.99 } }, expected: 24.99 },
  });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  const body = JSON.parse(fetch.calls[0].body);
  assert.deepEqual(body.received, { price: { amount: 29.99 } });
  assert.equal(body.expected, 24.99);
});
