#!/usr/bin/env node
/**
 * apinoa-mcp over stdio, for Claude Desktop, Claude Code, Cursor and any MCP client:
 *
 *   APINOA_API_KEY=... npx -y apinoa-mcp
 *
 * and `npx apinoa-mcp login`, which gets a key in the browser and writes it to .env (see login.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createApinoaServer } from "./server.js";

if (process.argv[2] === "login") {
  const { login, openInBrowser } = await import("./login.js");
  process.exitCode = await login({
    argv: process.argv.slice(3),
    env: process.env,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdout.isTTY === true,
    openBrowser: openInBrowser,
  });
} else {
  const server = await createApinoaServer();
  await server.connect(new StdioServerTransport());
  if (!process.env.APINOA_API_KEY) {
    console.error("apinoa-mcp: APINOA_API_KEY is not set — list_platforms works, every data call will answer 401.");
  }
}
