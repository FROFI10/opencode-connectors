#!/usr/bin/env node
/**
 * Memory MCP connector.
 *
 * Provides an AI agent with persistent long-term memory that survives across
 * sessions. Memories are stored in a local SQLite database; semantic search is
 * powered by xenova/transformers running fully offline.
 *
 * Recommended OpenCode system-prompt addition: "Before answering, consider
 * whether you should call `memory.recall` to look up relevant prior context.
 * When the user tells you something worth remembering, call `memory.remember`."
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";

const store = new MemoryStore();

const server = new McpServer({
  name: "memory-connector",
  version: "0.1.0",
});

function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

server.tool(
  "remember",
  "Persist a fact, preference, or context note to long-term memory. Returns the stored memory's id. " +
    "Call this whenever the user tells you something worth remembering (their preferences, names, ongoing projects, decisions, etc.). " +
    "Each memory is independently retrievable via `recall`.",
  {
    content: z.string().min(1).describe("The fact or note to remember."),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Optional labels for filtering later (e.g. ['preference', 'work']).",
      ),
    importance: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe(
        "1-5. Higher = surfaces more in recall results. Default: 3.",
      ),
  },
  async ({ content, tags, importance }) => {
    const m = await store.remember(content, tags ?? [], importance ?? 3);
    return jsonText({ id: m.id, stored: true, created_at: m.created_at });
  },
);

server.tool(
  "recall",
  "Semantic search over stored memories. Returns the most relevant memories by meaning (not just keyword match). " +
    "Use this at the START of an interaction or whenever the user references something that may have come up before.",
  {
    query: z.string().min(1).describe("Natural-language search query."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max results. Default: 10."),
    min_similarity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("0..1 cutoff. Default: 0.25 (lenient)."),
  },
  async ({ query, limit, min_similarity }) => {
    const results = await store.recall(query, limit ?? 10, min_similarity ?? 0.25);
    return jsonText({
      query,
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        tags: r.tags,
        importance: r.importance,
        created_at: r.created_at,
        similarity: Math.round(r.similarity * 1000) / 1000,
      })),
    });
  },
);

server.tool(
  "list_recent",
  "List the N most recently added memories (chronological, not semantic). Useful for catching up on what was stored recently.",
  {
    n: z.number().int().positive().optional().describe("Default: 20."),
  },
  async ({ n }) => jsonText({ memories: store.listRecent(n ?? 20) }),
);

server.tool(
  "search_by_tag",
  "List all memories tagged with the given tag.",
  {
    tag: z.string().min(1),
    limit: z.number().int().positive().optional(),
  },
  async ({ tag, limit }) =>
    jsonText({ tag, memories: store.searchByTag(tag, limit ?? 50) }),
);

server.tool(
  "get",
  "Fetch a specific memory by id.",
  { id: z.number().int().positive() },
  async ({ id }) => {
    const m = store.get(id);
    if (!m) return jsonText({ found: false, id });
    return jsonText({ found: true, memory: m });
  },
);

server.tool(
  "update",
  "Update an existing memory. Any omitted field is left unchanged. If `content` changes, the embedding is recomputed automatically.",
  {
    id: z.number().int().positive(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  },
  async ({ id, content, tags, importance }) => {
    const m = await store.update(id, { content, tags, importance });
    if (!m) return jsonText({ updated: false, id });
    return jsonText({ updated: true, memory: m });
  },
);

server.tool(
  "forget",
  "Permanently delete a memory by id.",
  { id: z.number().int().positive() },
  async ({ id }) => jsonText({ forgotten: store.forget(id), id }),
);

server.tool(
  "count",
  "Return the total number of stored memories.",
  {},
  async () => jsonText({ count: store.count(), path: store.path }),
);

server.tool(
  "export_all",
  "Dump every stored memory (id, content, tags, importance, timestamps). Useful for backup or inspection. Does not include embeddings.",
  {},
  async () => jsonText({ memories: store.exportAll() }),
);

// Convenience wrapper around `remember` for logging actions the agent just
// performed. Encourages a consistent tag scheme so later filtering / file
// history lookups work well. Stored content is intentionally short — full
// data should live in the filesystem; the memory holds the breadcrumb.
server.tool(
  "log_action",
  "Record that you just did something noteworthy — edited a file, opened a PR, ran a destructive command, made a design decision, etc. " +
    "Keep `summary` SHORT (one sentence). For file edits, prefer `target=<path>` and put what changed in `summary`. " +
    "This is a convenience wrapper over `remember` that auto-tags with `action` and `action:<type>` (and `target:<target>` if given) so you can later filter or list file history.",
  {
    type: z
      .string()
      .min(1)
      .describe(
        "Action category. Recommended values: 'file-edit', 'file-create', 'file-delete', 'command', 'decision', 'pr', 'commit', 'bug-fix', 'todo', 'note'.",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        "One-sentence description of what was done. Be specific. Bad: 'edited file'. Good: 'added dark-mode toggle to Settings.tsx'.",
      ),
    target: z
      .string()
      .optional()
      .describe(
        "What was acted on — a file path, PR number, repo, etc. Optional but strongly recommended.",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Extra free-form tags."),
    importance: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("1-5. Default: 3."),
  },
  async ({ type, summary, target, tags, importance }) => {
    const autoTags = ["action", `action:${type}`];
    if (target) autoTags.push(`target:${target}`);
    const allTags = Array.from(new Set([...autoTags, ...(tags ?? [])]));
    const content = target
      ? `[${type}] ${target}: ${summary}`
      : `[${type}] ${summary}`;
    const m = await store.remember(content, allTags, importance ?? 3);
    return jsonText({
      id: m.id,
      logged: true,
      content,
      tags: allTags,
    });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `memory-connector MCP server running on stdio (db: ${store.path})`,
  );
}

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    store.close();
  } catch {
    /* ignore */
  }
};
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
