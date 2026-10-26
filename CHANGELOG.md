# Changelog

## 0.2.1

- zod 4 (4.6.7, the version the MCP SDK already uses): zod 3 had a high-severity advisory (GHSA-mrhx-c7xc-m3w5,
  memory exhaustion on oversized collections), so `npm audit` on an install is now clean.

## 0.2.0

- **Code mode is the default.** Three tools instead of thirteen: `search_docs` finds the operations for a task
  (how to call each, every parameter, the cost, the fields returned), `execute` runs TypeScript the model
  writes against a typed `apinoa` client, and `translate_image` stays as it was. A task of many calls is one
  tool call, and only what the code returns comes back into the conversation.
- The code is type-checked against the API's types before it runs: an operation, parameter or field that does
  not exist fails there, before anything is billed.
- It runs in a Deno subprocess that reaches only the apinoa API and reads and writes only its data folder.
  The API key never enters the code. Each run has a unit budget, a time limit and an output cap; answers are
  cached for 10 minutes; `store` keeps data between runs.
- `apinoa.tiktok.media` (the video file) is reachable: `store.saveFile` writes it to disk.
- `APINOA_MCP_MODE=tools` serves the 0.1 tool set; the server falls back to it where Deno cannot run.
- Tool-set answers up to the 100,000-character cap now stay in the conversation in Claude Code
  (`anthropic/maxResultSizeChars`) instead of being moved to a file the model may have no tool to read.

## 0.1.1

- A social post's media keeps its main file, thumbnail and size, but no longer lists every rendition
  of it. A Threads search answer is about a quarter of its old size, so it fits the model's context.
- An answer over the size limit keeps whole items and stays valid JSON, with a note on how many items
  were left out. It used to be cut mid-JSON.
- First release published from GitHub Actions, with npm provenance.

## 0.1.0

First release.
