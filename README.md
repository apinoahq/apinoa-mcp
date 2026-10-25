# apinoa-mcp

An [MCP](https://modelcontextprotocol.io) server for [apinoa](https://apinoa.com). It gives Claude, Cursor
and any other MCP client live product data from Amazon, Walmart, Shopify, TikTok Shop and AliExpress,
social data from TikTok, YouTube, Instagram, Threads, X, Reddit and LinkedIn, and image translation.

Ask things like *"compare the top wool socks on Amazon and Walmart under $20"*, *"what has @nasa posted on
TikTok this week"* or *"translate the text on this product photo into Korean"*.

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

Requires Node.js 20 or later.

## Tools

| Tool | What it does |
|---|---|
| `search_products` | Search a marketplace by keyword, with filters |
| `search_products_by_image` | Find products matching a photo (given as a URL) |
| `get_product` | One product in full: variants, images, specs, seller, delivery |
| `get_product_reviews` | A product's reviews, page by page |
| `list_categories` / `browse_category` | Walk a marketplace's category tree and list a category's products |
| `get_social_profile` | One account: bio, follower counts, links |
| `list_social_posts` | An account's posts, a search, a hashtag, a community — or the trending feed |
| `get_social_post` | One post |
| `get_social_comments` | A post's comments or a comment's replies |
| `translate_image` | Replace the text in an image with a translation; returns the image |
| `call_apinoa` | Any other operation: store catalogs, shipping quotes, groups, LinkedIn jobs… |
| `list_platforms` | Every platform, its operations, their parameters and costs (free) |

Each tool takes a `platform`. The platforms and the parameters each accepts are read from the live API
catalog when the server starts, so a platform added to apinoa appears without updating this package.
Every tool only reads data.

## Options

| Variable | Default | |
|---|---|---|
| `APINOA_API_KEY` | — | Required for every data call. |
| `APINOA_BASE_URL` | `https://gateway.apinoa.com` | |

To keep the model's context usable, a post's media lists its main file and thumbnail but not every other
size of it (the SDKs and the API return all of them). An answer still over 100,000 characters keeps as many
whole items as fit, with a note saying how many were left out; ask for fewer items or a narrower query.

## Use as a library

```ts
import { createApinoaServer } from "apinoa-mcp";

const server = await createApinoaServer({ apiKey: process.env.APINOA_API_KEY });
// connect it to any MCP transport, e.g. Streamable HTTP
```

## Related

- [apinoa](https://www.npmjs.com/package/apinoa): the TypeScript SDK
- [apinoa on PyPI](https://pypi.org/project/apinoa/): the Python SDK
- [API documentation](https://apinoa.com/docs)

## License

MIT
