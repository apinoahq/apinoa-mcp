// The published entry point (dist/cli.js) over stdio against the real API: APINOA_API_KEY=... npm run test:live
// Two data calls, one unit each. Skipped without a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.APINOA_API_KEY;

test("the stdio server lists tools from the live catalog and answers real calls", { skip: !key && "set APINOA_API_KEY" }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))],
    env: { ...process.env, APINOA_API_KEY: key },
  });
  const client = new Client({ name: "live-test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.find((t) => t.name === "search_products").inputSchema.properties.platform.enum.includes("walmart"));

    const profile = await client.callTool({ name: "get_social_profile", arguments: { platform: "reddit", username: "spez" } });
    assert.equal(profile.isError, undefined, profile.content?.[0]?.text);
    assert.equal(JSON.parse(profile.content[0].text).handle.toLowerCase(), "spez");

    const search = await client.callTool({ name: "search_products", arguments: { platform: "walmart", query: "wool socks" } });
    assert.equal(search.isError, undefined, search.content?.[0]?.text);
    assert.ok(JSON.parse(search.content[0].text).items.length > 0);
  } finally {
    await client.close();
  }
});
