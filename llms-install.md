# Installing apinoa-mcp

These steps are for an AI agent (Cline and others) setting up this MCP server for its user.

1. The user needs an apinoa API key. If they don't have one, ask them to create it at
   https://apinoa.com/en/dashboard/api-keys and paste it. Don't invent one; every data call needs it.
2. Check that Node.js 20 or later is installed (`node --version`).
3. Add this server to the client's MCP settings (for Cline: `cline_mcp_settings.json`), with the key in `env`:

```json
{
  "mcpServers": {
    "apinoa": {
      "command": "npx",
      "args": ["-y", "apinoa-mcp"],
      "env": { "APINOA_API_KEY": "the user's key" }
    }
  }
}
```

4. Reload the MCP servers. In its default code mode the server exposes `search_docs`, which finds the operations
   for a task, and `execute`, which runs TypeScript the model writes against a typed client
   (`apinoa.<platform>.<operation>(params)`) in a sandbox. To get one tool per kind of read instead, add
   `"APINOA_MCP_MODE": "tools"` to `env`.
5. Verify it by asking for something small, for example "search Amazon for wool socks under $30". Calls are billed to
   the key at the normal rates, and failed calls are not billed.

Everything the server can reach (marketplaces, social platforms, search engines, AI answer engines) is listed live at
`GET https://gateway.apinoa.com/v1/marketplaces`. Documentation: https://apinoa.com/docs/sdks.
