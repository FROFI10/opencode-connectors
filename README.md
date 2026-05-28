# opencode-connectors

A collection of connectors (tools / plugins) for [OpenCode](https://opencode.ai) and other AI agents that speak the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Status:** scaffold + one connector (`github`). Use `connectors/_template` as a starting point when you add a new one.

## Available connectors

| Name | Description |
|------|-------------|
| [`github`](connectors/github/) | Manage GitHub on your behalf: create/delete repos, commit files, manage branches, open and merge PRs, work with issues. |

## What is a connector?

A connector is a bridge between an AI agent (like OpenCode) and an external service (GitHub, Telegram, Slack, your own API, a database, etc.).

It does three things:

1. **Authenticates** with the external service (API key, OAuth, token).
2. **Exposes actions** to the agent as named *tools* with typed inputs and outputs (e.g. `send_email`, `list_repos`, `create_issue`).
3. **Executes** those actions on behalf of the user when the agent calls them.

Most modern agents speak MCP, so a connector here is implemented as a small MCP server. The same connector can then be plugged into OpenCode, Claude Desktop, Cursor, Continue, or anything else that supports MCP.

## Repository layout

```
opencode-connectors/
├── connectors/
│   ├── _template/           # Copy this folder to start a new connector
│   │   ├── src/index.ts     # MCP server entry point
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── README.md
│   └── github/              # GitHub connector
├── docs/
│   ├── what-are-connectors.md
│   └── how-to-add-a-connector.md
├── package.json             # npm workspace root
├── tsconfig.json            # base TS config
└── README.md
```

Each connector lives in its own folder under `connectors/` and is an independent npm package, managed as a workspace.

## Quick start — add a new connector

```bash
# 1. Copy the template
cp -r connectors/_template connectors/my-service

# 2. Edit name in connectors/my-service/package.json
# 3. Implement your tools in connectors/my-service/src/index.ts
# 4. Install deps & build
npm install
npm run build --workspace=connectors/my-service
```

See [`docs/how-to-add-a-connector.md`](docs/how-to-add-a-connector.md) for details.

## Using a connector with OpenCode

The repo ships with an [`opencode.json`](opencode.json) that already wires up the `github` connector. To add another connector, append it under `mcp`:

```json
{
  "mcp": {
    "my-service": {
      "type": "local",
      "command": ["node", "./connectors/my-service/dist/index.js"],
      "enabled": true
    }
  }
}
```

OpenCode spawns the connector as a subprocess and auto-discovers its tools.

## Quick start

```bash
npm install
npm run build
# Then launch OpenCode in this folder — opencode.json is picked up automatically.
```

## License

MIT — see [`LICENSE`](LICENSE).
