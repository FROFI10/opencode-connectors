# Template connector

A minimal MCP connector you can copy as a starting point for new connectors.

## What's inside

- `src/index.ts` — MCP server that exposes a single `echo` tool over stdio
- `package.json` — declares dependencies on `@modelcontextprotocol/sdk` and `zod`
- `tsconfig.json` — extends the root TS config

## Use it as a starting point

```bash
# From the repo root
cp -r connectors/_template connectors/my-service
```

Then in `connectors/my-service/`:

1. Rename the package in `package.json` (`@opencode-connectors/my-service`) and update the `bin` entry.
2. Replace the `echo` tool in `src/index.ts` with your real tools — one `server.tool(...)` call per action.
3. Add SDK dependencies for the service you're wrapping (e.g. `@octokit/rest` for GitHub, `node-telegram-bot-api` for Telegram).
4. Read API keys / tokens from `process.env` — never hardcode secrets.

## Build and run locally

```bash
npm install                                    # from the repo root
npm run build --workspace=connectors/_template
node connectors/_template/dist/index.js        # runs the MCP server on stdio
```

## Wire it into OpenCode

In your `opencode.json`:

```json
{
  "mcp": {
    "template": {
      "type": "local",
      "command": ["node", "./connectors/_template/dist/index.js"],
      "enabled": true,
      "environment": {
        "EXAMPLE_API_KEY": "${EXAMPLE_API_KEY}"
      }
    }
  }
}
```

The `environment` block forwards env vars from your shell into the connector
process — use it to pass API keys without committing them to the config file.
