# archscript-mcp (bridge)

A small, dependency-free stdio MCP server that connects MCP clients to the MCP
server built into **ArchScript for Mac** (`http://127.0.0.1:47621/mcp`, bearer
token). It forwards JSON-RPC messages unchanged; all tools run in the app.

```bash
node index.js --token <token from ArchScript → Settings → AI>
# or: ARCHSCRIPT_TOKEN=<token> ARCHSCRIPT_PORT=47621 node index.js
```

- On a Mac it starts ArchScript in the background when a tool is called and the app isn't running.
- Without the app (another OS, a container, wrong token) it still answers
  `initialize` and `tools/list` from [`tools.json`](tools.json), and tool calls
  return a message that explains how to connect ArchScript for Mac.
- Requires Node.js 18 or later. MIT licensed.
