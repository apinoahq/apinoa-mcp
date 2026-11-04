// server.json is what the official MCP Registry lists, and the registry accepts it only when the npm package
// names the same server (package.json `mcpName`). The publish workflow sets its version from package.json; the
// names are kept in step here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

test("server.json and package.json name the same server and package", () => {
  const pkg = read("package.json");
  const server = read("server.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.ok(server.description.length <= 100, "the registry refuses a description over 100 characters");
  const env = server.packages[0].environmentVariables.map((v) => v.name);
  assert.ok(env.includes("APINOA_API_KEY"));
});
