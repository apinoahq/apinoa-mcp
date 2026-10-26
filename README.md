# apinoa-mcp

An [MCP](https://modelcontextprotocol.io) server for [apinoa](https://apinoa.com). It gives Claude, Cursor
and any other MCP client live product data from Amazon, Walmart, Shopify, TikTok Shop and AliExpress,
social data from TikTok, YouTube, Instagram, Threads, X, Reddit and LinkedIn, and image translation.

Ask things like *"which of @duolingo's last 30 TikToks got 3x its usual views"*, *"compare the cheapest
Stanley 40 oz on Amazon and Walmart"* or *"translate the text on this product photo into Korean"*.

## Setup

Create a key under **Dashboard > API keys** at [apinoa.com](https://apinoa.com). Calls are billed to it
at the API's normal rates; a call that fails is not billed.

**Claude Code**

```sh
claude mcp add apinoa -e APINOA_API_KEY=your_key -- npx -y apinoa-mcp
```

**Claude Desktop, Cursor, Windsurf and others** — add to the client's MCP configuration
(`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "apinoa": {
      "command": "npx",
      "args": ["-y", "apinoa-mcp"],
      "env": { "APINOA_API_KEY": "your_key" }
    }
  }
}
```

Requires Node.js 20 or later. The package installs [Deno](https://deno.com), which runs the model's code.

## Tools

| Tool | What it does |
|---|---|
| `search_docs` | Finds the operations for a task: how to call each, every parameter, the cost, and the fields it returns. Free |
| `execute` | Runs TypeScript the model writes against the API, and returns only what the code returns or prints |
| `translate_image` | Replaces the text in an image with a translation; returns the image |

Instead of one tool call per API call, the model writes a short program. Fanning out over 50 accounts,
following pages, filtering and averaging happen in the code, and only the answer comes back into the
conversation:

```ts
const page = await apinoa.tiktok.posts({ username: "duolingo", limit: 30 });
const views = page.items.map((p) => p.metrics?.views ?? 0).sort((a, b) => a - b);
const median = views[Math.floor(views.length / 2)];
return page.items.filter((p) => (p.metrics?.views ?? 0) >= 3 * median).map((p) => p.url);
```

Inside `execute`:

- `apinoa.<platform>.<operation>(params)`: one API call; returns the answer's `data`, throws `ApinoaError`
  (`code`, `status`) on a refusal.
- `pages(op, params, { maxPages })`: every item of a paged operation, following cursors.
- `many(items, fn, { concurrency })`: `fn` over every item, 8 at a time; an item that fails comes back
  `undefined` and is counted.
- `store.save / load / list / saveFile`: data kept on your machine between runs (videos from
  `apinoa.tiktok.media`, for example).
- `usage`: this run's calls and units.

The code is type-checked against the API's types before it runs, so an operation, parameter or field that
does not exist fails there, before anything is billed. Each run has a budget (500 units by default, set per
run with `budget_units`) and stops once it is spent. Answers are cached for 10 minutes, so running fixed
code again costs nothing for the calls already made.

The code runs in a Deno subprocess that can reach only the apinoa API and read and write only its data
folder: no other hosts, no other files, no environment variables, no programs. The API key never enters
the code; the sandbox adds it to each request.

The platforms, operations and parameters are read from the live API catalog when the server starts, so a
platform added to apinoa appears without updating this package.

### The tool set

`APINOA_MCP_MODE=tools` serves the 0.1 tools instead: one tool per kind of read (`search_products`,
`get_product`, `list_social_posts`, `get_social_comments`, `call_apinoa`, `list_platforms`, …), one API call
per tool call. The server falls back to it by itself where Deno cannot run. An answer over 100,000
characters keeps as many whole items as fit, with a note saying how many were left out.

## Options

| Variable | Default | |
|---|---|---|
| `APINOA_API_KEY` | — | Required for every data call. |
| `APINOA_BASE_URL` | `https://gateway.apinoa.com` | |
| `APINOA_MCP_MODE` | `code` | `tools` for the 0.1 tool set. |
| `APINOA_MCP_DATA_DIR` | `~/.apinoa-mcp` | Where the cache, `store` and saved files live. |
| `APINOA_MCP_MAX_BUDGET` | `20000` | The most units one run may be given. |
| `APINOA_MCP_CONCURRENCY` | `16` | API calls in flight at once within a run. |
| `APINOA_MCP_CACHE_TTL_S` | `600` | How long an answer is reused; `0` turns the cache off. |
| `APINOA_MCP_MAX_OUTPUT` | `40000` | The most characters of output one run hands back to the model. |
| `APINOA_MCP_DENO` | the bundled one | Path to another `deno`. |

## Use as a library

```ts
import { createApinoaServer } from "apinoa-mcp";

const server = await createApinoaServer({ apiKey: process.env.APINOA_API_KEY });
// connect it to any MCP transport, e.g. Streamable HTTP
```

## Related

- [@apinoa/sdk](https://www.npmjs.com/package/@apinoa/sdk): the TypeScript SDK
- [apinoa on PyPI](https://pypi.org/project/apinoa/): the Python SDK
- [API documentation](https://apinoa.com/docs)

## License

MIT
