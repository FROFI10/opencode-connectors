# Memory connector

A long-term memory MCP connector that gives an AI agent persistent recall across sessions, even after context windows have been wiped or summarized.

Memories are stored locally in SQLite at `~/.opencode-connectors/memory.db`. Semantic search is powered by [sentence-transformers all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) running fully offline via [@xenova/transformers](https://github.com/xenova/transformers.js). No external API, no telemetry, no cloud.

## Why

LLMs forget things the moment the context window closes. This connector gives the agent two tools — `remember` and `recall` — that let it stash and retrieve facts by meaning. The agent's working context stays small; the long-term memory lives outside.

## Setup

From the repo root:

```bash
npm install
npm run build
```

The embedding model (~25 MB) downloads on first use of `remember` or `recall` and caches under `~/.cache/huggingface` (or the platform equivalent). Override with `MEMORY_MODEL_CACHE`.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `MEMORY_DB_PATH` | `~/.opencode-connectors/memory.db` | Where to store the SQLite database. |
| `MEMORY_MODEL_CACHE` | platform default | Where to cache the embedding model. |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Which sentence-transformer to load. For non-English content set `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (50+ languages incl. Russian). If you change this on an existing database the old vectors are still 384-dim and will be compared — re-embed by re-creating the DB if scores look off. |

## Wiring it into OpenCode

In `opencode.json`:

```json
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["node", "./connectors/memory/dist/index.js"],
      "enabled": true
    }
  }
}
```

For best results, add a hint to OpenCode's system prompt so the model proactively uses memory:

> *Before answering, consider whether you should call `memory.recall` to look up relevant prior context. When the user tells you something worth remembering — preferences, names, ongoing projects, decisions, important facts — call `memory.remember`.*

## Tools

- `remember(content, tags?, importance?)` — store a fact. `importance` is 1-5 (default 3); higher = surfaces more in recall.
- `recall(query, limit?, min_similarity?)` — semantic search; returns memories ranked by cosine similarity blended with importance.
- `list_recent(n?)` — last N memories chronologically (default 20).
- `search_by_tag(tag, limit?)` — memories tagged with `tag`.
- `get(id)` — fetch one memory by id.
- `update(id, content?, tags?, importance?)` — modify an existing memory; embedding is recomputed if content changes.
- `forget(id)` — delete a memory.
- `count()` — total stored.
- `export_all()` — dump everything (for backup/inspection).

## How recall works

1. The query is converted to a 384-dim float vector by the local embedding model.
2. Every stored memory's vector is loaded and dot-producted with the query vector (vectors are L2-normalized, so dot product = cosine similarity).
3. Results above `min_similarity` are ranked by `similarity + importance × 0.02` and trimmed to `limit`.

For databases up to a few tens of thousands of rows, scanning every row is fast enough (sub-100 ms). If you ever need to scale further, swap in `sqlite-vss` or `hnswlib-node` — the storage format already keeps embeddings as BLOBs to make that drop-in.

## Privacy

Everything is local. The embedding model runs on your CPU, the database lives on your disk, nothing leaves the machine. The only network activity is the one-time model download from HuggingFace's CDN.
