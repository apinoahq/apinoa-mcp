#!/usr/bin/env node
/**
 * apinoa-mcp over stdio, for Claude Desktop, Claude Code, Cursor and any MCP client:
 *
 *   APINOA_API_KEY=... npx -y apinoa-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createApinoaServer } from "./server.js";

const server = await createApinoaServer();
await server.connect(new StdioServerTransport());
if (!process.env.APINOA_API_KEY) {
  console.error("apinoa-mcp: APINOA_API_KEY is not set — list_platforms works, every data call will answer 401.");
}
