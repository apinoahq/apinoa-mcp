// The published entry point (dist/cli.js) over stdio against the real API: APINOA_API_KEY=... npm run test:live
// A few data calls, one or two units each. Skipped without a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.APINOA_API_KEY;

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))],
    env: { ...process.env, APINOA_API_KEY: key, APINOA_MCP_DATA_DIR: await mkdtemp(join(tmpdir(), "apinoa-live-")), ...env },
  });
  const client = new Client({ name: "live-test", version: "0" });
  await client.connect(transport);
  return client;
}

test("code mode: search_docs, then code that calls the real API and returns only its result", { skip: !key && "set APINOA_API_KEY" }, async () => {
  const client = await connect({});
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["execute", "search_docs", "translate_image"]);

    const docs = (await client.callTool({ name: "search_docs", arguments: { query: "walmart product search" } })).content[0].text;
    assert.match(docs, /apinoa\.walmart\.search\(params\) → SearchResult/);

    const run = await client.callTool(
      {
        name: "execute",
        arguments: {
          code: `const [spez, socks] = await Promise.all([apinoa.reddit.profile({ username: "spez" }), apinoa.walmart.search({ query: "wool socks" })]);
return { handle: spez.handle.toLowerCase(), items: socks.items.length };`,
        },
      },
      undefined,
      { timeout: 120_000 },
    );
    const text = run.content[0].text;
    assert.equal(run.isError, undefined, text);
    assert.match(text, /"handle": "spez"/);
    assert.match(text, /\[apinoa: 2 calls, \d+ of 500 units/);
  } finally {
    await client.close();
  }
});

test("tool set: lists tools from the live catalog and answers real calls", { skip: !key && "set APINOA_API_KEY" }, async () => {
  const client = await connect({ APINOA_MCP_MODE: "tools" });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.find((t) => t.name === "search_products").inputSchema.properties.platform.enum.includes("walmart"));

    const profile = await client.callTool({ name: "get_social_profile", arguments: { platform: "reddit", username: "spez" } });
    assert.equal(profile.isError, undefined, profile.content?.[0]?.text);
    assert.equal(JSON.parse(profile.content[0].text).handle.toLowerCase(), "spez");
  } finally {
    await client.close();
  }
});
