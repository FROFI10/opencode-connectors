/**
 * SQLite-backed memory store with semantic search via local embeddings.
 *
 * Schema:
 *   memories(id INTEGER PK, content TEXT, tags TEXT (JSON array),
 *            importance INTEGER, created_at INTEGER, updated_at INTEGER,
 *            embedding BLOB)
 *
 * Embeddings are 384-dimensional float32 vectors from sentence-transformers
 * all-MiniLM-L6-v2 (downloaded once on first use, ~25 MB, cached in
 * ~/.cache/huggingface or platform equivalent).
 *
 * Cosine similarity is computed in Node — fine for thousands of rows.
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const EMBEDDING_DIM = 384;

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  importance: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryWithScore extends Memory {
  similarity: number;
}

function defaultDbPath(): string {
  if (process.env.MEMORY_DB_PATH) return process.env.MEMORY_DB_PATH;
  const dir = join(homedir(), ".opencode-connectors");
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.db");
}

// Lazy embedder so the connector starts fast and only pulls the model on
// first use of `remember` or `recall`.
let embedderPromise: Promise<(text: string) => Promise<Float32Array>> | null =
  null;

async function getEmbedder(): Promise<(text: string) => Promise<Float32Array>> {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    const tx = await import("@xenova/transformers");
    // Allow cache dir override; default is platform's standard cache.
    if (process.env.MEMORY_MODEL_CACHE) {
      tx.env.cacheDir = process.env.MEMORY_MODEL_CACHE;
    }
    const pipe = await tx.pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
    return async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      // out.data is a Float32Array of length 384.
      return new Float32Array(out.data);
    };
  })();
  return embedderPromise;
}

function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToVec(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors are already L2-normalized by the embedder, so cosine = dot product.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class MemoryStore {
  private db: Database.Database;
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? defaultDbPath();
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    `);
  }

  async remember(
    content: string,
    tags: string[] = [],
    importance: number = 3,
  ): Promise<Memory> {
    const embed = await getEmbedder();
    const vec = await embed(content);
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memories (content, tags, importance, created_at, updated_at, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(content, JSON.stringify(tags), importance, now, now, vecToBuffer(vec));
    return {
      id: Number(info.lastInsertRowid),
      content,
      tags,
      importance,
      created_at: now,
      updated_at: now,
    };
  }

  async recall(
    query: string,
    limit: number = 10,
    minSimilarity: number = 0.25,
  ): Promise<MemoryWithScore[]> {
    const embed = await getEmbedder();
    const qVec = await embed(query);
    const rows = this.db
      .prepare(
        `SELECT id, content, tags, importance, created_at, updated_at, embedding FROM memories`,
      )
      .all() as Array<{
      id: number;
      content: string;
      tags: string;
      importance: number;
      created_at: number;
      updated_at: number;
      embedding: Buffer;
    }>;

    const scored: MemoryWithScore[] = [];
    for (const r of rows) {
      const v = bufferToVec(r.embedding);
      if (v.length !== EMBEDDING_DIM) continue;
      const sim = cosine(qVec, v);
      if (sim < minSimilarity) continue;
      scored.push({
        id: r.id,
        content: r.content,
        tags: JSON.parse(r.tags),
        importance: r.importance,
        created_at: r.created_at,
        updated_at: r.updated_at,
        similarity: sim,
      });
    }
    // Blend similarity with importance so important memories surface more.
    scored.sort((a, b) => {
      const aScore = a.similarity + a.importance * 0.02;
      const bScore = b.similarity + b.importance * 0.02;
      return bScore - aScore;
    });
    return scored.slice(0, limit);
  }

  get(id: number): Memory | null {
    const r = this.db
      .prepare(
        `SELECT id, content, tags, importance, created_at, updated_at FROM memories WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          content: string;
          tags: string;
          importance: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!r) return null;
    return { ...r, tags: JSON.parse(r.tags) };
  }

  listRecent(n: number = 20): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT id, content, tags, importance, created_at, updated_at FROM memories ORDER BY created_at DESC LIMIT ?`,
      )
      .all(n) as Array<{
      id: number;
      content: string;
      tags: string;
      importance: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
  }

  searchByTag(tag: string, limit: number = 50): Memory[] {
    // SQLite JSON1 functions are available by default in better-sqlite3.
    const rows = this.db
      .prepare(
        `SELECT id, content, tags, importance, created_at, updated_at
         FROM memories
         WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(tag, limit) as Array<{
      id: number;
      content: string;
      tags: string;
      importance: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
  }

  async update(
    id: number,
    fields: { content?: string; tags?: string[]; importance?: number },
  ): Promise<Memory | null> {
    const existing = this.get(id);
    if (!existing) return null;
    const content = fields.content ?? existing.content;
    const tags = fields.tags ?? existing.tags;
    const importance = fields.importance ?? existing.importance;
    const now = Date.now();
    let embeddingBuf: Buffer | null = null;
    if (fields.content && fields.content !== existing.content) {
      const embed = await getEmbedder();
      embeddingBuf = vecToBuffer(await embed(content));
    }
    if (embeddingBuf) {
      this.db
        .prepare(
          `UPDATE memories SET content=?, tags=?, importance=?, updated_at=?, embedding=? WHERE id=?`,
        )
        .run(content, JSON.stringify(tags), importance, now, embeddingBuf, id);
    } else {
      this.db
        .prepare(
          `UPDATE memories SET content=?, tags=?, importance=?, updated_at=? WHERE id=?`,
        )
        .run(content, JSON.stringify(tags), importance, now, id);
    }
    return { id, content, tags, importance, created_at: existing.created_at, updated_at: now };
  }

  forget(id: number): boolean {
    const info = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  count(): number {
    const r = this.db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as {
      c: number;
    };
    return r.c;
  }

  exportAll(): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT id, content, tags, importance, created_at, updated_at FROM memories ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      content: string;
      tags: string;
      importance: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
  }

  close() {
    this.db.close();
  }
}
