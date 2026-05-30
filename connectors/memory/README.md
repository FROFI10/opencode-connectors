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

For the connector to be useful you MUST paste the system prompt below into OpenCode's settings (or wherever your agent gets its system prompt). Without it the model has the tools but rarely calls them on its own.

### Recommended system prompt

Copy this verbatim:

```
You have access to a `memory` connector that persists notes across sessions.
Use it actively — do NOT rely only on your context window.

AT THE START of a non-trivial interaction:
  1. Call `memory.recall(query)` with a query summarising what the user just
     asked. Read the results before responding.
  2. If you need more, call `memory.search_by_tag` or `memory.list_recent`.

DURING / AFTER work, call `memory.remember` or `memory.log_action` for:
  - User preferences, identity, ongoing projects, decisions they made
  - Important facts they stated ("my db is at X", "I use Y framework")
  - Bugs you found or fixed (one entry per bug)
  - Files you edited — use `memory.log_action(type='file-edit',
    target='<path>', summary='<what changed>')`
  - Commits, PRs, deployments — `memory.log_action(type='pr', target='#42', summary='...')`
  - Open todos that don't fit in the current turn

Do NOT store:
  - Full file contents (they live in the filesystem already)
  - Conversation transcripts (only outcomes / decisions)
  - Secrets or credentials — ever

Keep entries SHORT — one sentence is ideal, three sentences max.
Use `importance` 1-5: 5 = critical (auth, security, hard rules),
3 = default, 1 = trivia.

Use these tag conventions so search stays clean:
  - kind: `preference` | `fact` | `decision` | `bug` | `todo` | `note`
  - scope: `project:<name>` | `repo:<name>`
  - person: `person:<name>`
  - `log_action` adds its own tags automatically
```

## Tools

- `remember(content, tags?, importance?)` — store a fact. `importance` is 1-5 (default 3); higher = surfaces more in recall.
- `log_action(type, summary, target?, tags?, importance?)` — convenience wrapper over `remember`. Auto-tags with `action`, `action:<type>`, `target:<target>`. Use for "I just did X". Keep `summary` short, point at filesystem/PR for the full details.
- `recall(query, limit?, min_similarity?)` — semantic search; returns memories ranked by cosine similarity blended with importance.
- `list_recent(n?)` — last N memories chronologically (default 20).
- `search_by_tag(tag, limit?)` — memories tagged with `tag`. For file history, search `target:<path>`.
- `get(id)` — fetch one memory by id.
- `update(id, content?, tags?, importance?)` — modify an existing memory; embedding is recomputed if content changes.
- `forget(id)` — delete a memory.
- `count()` — total stored.
- `export_all()` — dump everything (for backup/inspection).

## Tag conventions

Search quality depends on consistent tagging. The recommended scheme:

| Prefix / value | Meaning | Example |
|---|---|---|
| `preference` | User preference | tags=['preference'] for "I prefer dark mode" |
| `fact` | Plain factual statement | tags=['fact'] for "DB lives at db.example.com" |
| `decision` | A decision that was made | tags=['decision'] for "chose Postgres over Mongo" |
| `bug` / `bug-fix` | Bug or its fix | tags=['bug-fix', 'repo:my-app'] |
| `todo` | Outstanding work | tags=['todo'] |
| `action` (auto) | Added by `log_action` | — |
| `action:<type>` (auto) | Subtype | `action:file-edit`, `action:pr` |
| `target:<value>` (auto) | What was acted on | `target:src/foo.ts`, `target:#42` |
| `repo:<name>` | Repo scope | `repo:opencode-connectors` |
| `project:<name>` | Project scope | `project:landing-page-v2` |
| `person:<name>` | About a specific person | `person:alice` |

## Use cases

- **"What were we doing last week?"** → `recall(query="recent work", limit=20)` or `list_recent(50)`.
- **"When did this file last change?"** → `search_by_tag("target:src/foo.ts")` returns all logged edits.
- **"What are my preferences?"** → `search_by_tag("preference")`.
- **"What open todos do I have?"** → `search_by_tag("todo")`.
- **"Did we ever decide on X?"** → `recall("decision about X")`.

## How recall works

1. The query is converted to a 384-dim float vector by the local embedding model.
2. Every stored memory's vector is loaded and dot-producted with the query vector (vectors are L2-normalized, so dot product = cosine similarity).
3. Results above `min_similarity` are ranked by `similarity + importance × 0.02` and trimmed to `limit`.

For databases up to a few tens of thousands of rows, scanning every row is fast enough (sub-100 ms). If you ever need to scale further, swap in `sqlite-vss` or `hnswlib-node` — the storage format already keeps embeddings as BLOBs to make that drop-in.

## Privacy

Everything is local. The embedding model runs on your CPU, the database lives on your disk, nothing leaves the machine. The only network activity is the one-time model download from HuggingFace's CDN.
