# What are connectors?

A **connector** is a small program that lets an AI agent talk to an external service.

By itself, a language model can only generate text. To actually *do* things in the
world — read your email, push a commit, send a Slack message, query a database —
it needs a bridge. That bridge is the connector.

## What a connector does

1. **Authenticates** with the external service (API key, OAuth token, etc).
2. **Describes its actions** to the agent as a list of *tools* — named functions
   with typed inputs and outputs.
3. **Executes** those actions when the agent calls them and returns the result.

## Why MCP?

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) is an open
standard from Anthropic for connecting agents to tools. The big advantage: a
connector written for MCP works with **any** MCP-compatible agent —
OpenCode, Claude Desktop, Cursor, Continue, Cody, Goose, and more.

So instead of writing a separate plugin for each agent, you write one MCP
server and plug it into all of them.

## Anatomy of an MCP connector

A typical MCP server:

- Listens on **stdio** (standard input/output) for JSON-RPC messages from the host agent.
- Exposes a list of **tools** when the agent asks (`tools/list`).
- Executes a tool when the agent calls it (`tools/call`).
- May also expose **resources** (read-only data) and **prompts** (reusable templates).

That's it. The MCP TypeScript SDK handles all the wire protocol — you just
register your tools.

## Examples of useful connectors

| Service           | Example tools                                                                 |
|-------------------|-------------------------------------------------------------------------------|
| GitHub            | `list_repos`, `create_issue`, `create_pr`, `comment_on_pr`                    |
| Telegram          | `send_message`, `get_chat_history`                                            |
| Slack             | `post_message`, `list_channels`, `react`                                      |
| Notion            | `search_pages`, `create_page`, `update_block`                                 |
| Google Drive      | `list_files`, `download_file`, `upload_file`                                  |
| Postgres / MySQL  | `run_query`, `describe_schema`                                                |
| Filesystem        | `read_file`, `write_file`, `list_directory` (built into many agents already)  |
| Browser           | `navigate`, `click`, `type`, `screenshot` (e.g. via Playwright)               |
| Home Assistant    | `turn_on`, `turn_off`, `get_state`                                            |

## See also

- [How to add a connector](./how-to-add-a-connector.md) — practical step-by-step
- [Model Context Protocol docs](https://modelcontextprotocol.io)
- [OpenCode docs](https://opencode.ai/docs)
