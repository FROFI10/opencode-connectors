# How to add a new connector

This walks through creating a connector for an imaginary service called **Acme**.

## 1. Copy the template

From the repo root:

```bash
cp -r connectors/_template connectors/acme
```

## 2. Rename the package

Edit `connectors/acme/package.json`:

```json
{
  "name": "@opencode-connectors/acme",
  "bin": {
    "opencode-connector-acme": "dist/index.js"
  }
}
```

## 3. Add any SDK dependencies

If Acme has an official SDK, install it:

```bash
npm install acme-sdk --workspace=connectors/acme
```

Otherwise just use `fetch` — it's built into Node 20+.

## 4. Define your tools

Replace the `echo` tool in `connectors/acme/src/index.ts`. Each `server.tool(...)`
call registers one action. Inputs are validated with Zod schemas, so the agent
sees a typed signature.

```typescript
import { z } from "zod";

server.tool(
  "list_widgets",
  "List all widgets in your Acme account.",
  {
    limit: z.number().int().min(1).max(100).default(20)
      .describe("Maximum number of widgets to return"),
  },
  async ({ limit }) => {
    const res = await fetch(`https://api.acme.com/widgets?limit=${limit}`, {
      headers: { Authorization: `Bearer ${process.env.ACME_API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Acme API error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);
```

### Good tool design

- **One clear action per tool.** Don't make a do-everything `acme` tool.
- **Descriptive names** (`create_widget`, not `cw`). The model uses the name to decide when to call it.
- **Tight Zod schemas.** Validate everything — the model will sometimes pass garbage.
- **Helpful descriptions.** Both for the tool and each parameter. The agent reads these to decide *whether* and *how* to use the tool.
- **Return text.** Most agents only render text content blocks. JSON-stringify structured data.
- **Fail loudly.** Throw on bad input or API errors — the agent will surface the message and can recover.

## 5. Build and test

```bash
npm install                                # from the repo root
npm run build --workspace=connectors/acme
```

Test it manually with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node connectors/acme/dist/index.js
```

The inspector opens a web UI where you can list and invoke tools without
needing a real agent.

## 6. Wire it into OpenCode

In your `opencode.json`:

```json
{
  "mcp": {
    "acme": {
      "type": "local",
      "command": ["node", "./connectors/acme/dist/index.js"],
      "enabled": true,
      "environment": {
        "ACME_API_KEY": "${ACME_API_KEY}"
      }
    }
  }
}
```

Restart OpenCode and your tools will appear under the `acme` namespace.

## 7. Handling secrets

**Never** commit API keys, tokens, or credentials to git. Patterns that work:

- Read from `process.env` inside the connector.
- Set the env vars in your shell (or `.env` file — gitignored) before launching OpenCode.
- Use OpenCode's `environment` block (above) to forward them into the connector subprocess.

If a secret is missing, fail fast with a clear message:

```typescript
const apiKey = process.env.ACME_API_KEY;
if (!apiKey) {
  throw new Error("ACME_API_KEY is not set. Get one at https://acme.com/settings/api");
}
```
