#!/usr/bin/env node
/**
 * Template MCP connector.
 *
 * An MCP server exposes a set of `tools` (named actions with typed input/output)
 * that an AI agent can call. This template defines a single `echo` tool — copy
 * this folder, rename it, and replace `echo` with the real actions your service
 * exposes (e.g. `send_message`, `list_items`, `create_issue`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "template-connector",
  version: "0.1.0",
});

server.tool(
  "echo",
  "Echo back the given message. Replace this with your real tool.",
  {
    message: z.string().describe("The text to echo back"),
  },
  async ({ message }) => ({
    content: [
      {
        type: "text",
        text: `echo: ${message}`,
      },
    ],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("template-connector MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
