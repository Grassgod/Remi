/**
 * Vector store: CRUD operations over sqlite-vec.
 * Wraps db/index.ts + db/embedding.ts.
 */

import { getDb } from "./index";
import { embed, embedQuery, type EmbeddingConfig } from "./embedding";
import { createHash } from "node:crypto";

export class VectorStore {
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  /** Check if content is already embedded with the same hash. */
  has(id: string, contentHash: string): boolean {
    const db = getDb();
    const row = db
      .query("SELECT content_hash FROM embeddings WHERE id = ?")
      .get(id) as { content_hash: string } | null;
    return row?.content_hash === contentHash;
  }

  /** Upsert: embed text and store vector + metadata. Skips if content unchanged. */
  async upsert(
    id: string,
    text: string,
    metadata?: Record<string, string>,
  ): Promise<boolean> {
    const hash = contentHash(text);
    if (this.has(id, hash)) return false; // Already up-to-date

    const vectors = await embed([text], this.config);
    if (vectors.length === 0) return false;

    const db = getDb();
    const vector = vectors[0];

    // Check if this id already has a rowid in embeddings
    const existing = db
      .query("SELECT rowid FROM embeddings WHERE id = ?")
      .get(id) as { rowid: number } | null;

    if (existing) {
      // Update existing vector
      db.run(
        "UPDATE vec_items SET embedding = ? WHERE rowid = ?",
        [new Float32Array(vector), existing.rowid],
      );
      db.run(
        "UPDATE embeddings SET content_hash = ?, metadata = ?, embedded_at = datetime('now') WHERE id = ?",
        [hash, metadata ? JSON.stringify(metadata) : null, id],
      );
    } else {
      // Insert new vector — vec_items auto-assigns rowid
      const result = db.run(
        "INSERT INTO vec_items (embedding) VALUES (?)",
        [new Float32Array(vector)],
      );
      const rowid = Number(result.lastInsertRowid);
      db.run(
        "INSERT INTO embeddings (id, content_hash, metadata, embedded_at, rowid) VALUES (?, ?, ?, datetime('now'), ?)",
        [id, hash, metadata ? JSON.stringify(metadata) : null, rowid],
      );
    }

    return true;
  }

  /** Search for similar vectors. Returns top-K results with distance + metadata. */
  async search(
    query: string,
    topK: number = 10,
  ): Promise<Array<{ id: string; distance: number; metadata?: Record<string, string> }>> {
    const queryVec = await embedQuery(query, this.config);
    if (queryVec.length === 0) return [];

    const db = getDb();
    const rows = db
      .query(
        `SELECT v.rowid, v.distance, e.id, e.metadata
         FROM vec_items v
         JOIN embeddings e ON e.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
      )
      .all(new Float32Array(queryVec), topK) as Array<{
        rowid: number;
        distance: number;
        id: string;
        metadata: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      distance: r.distance,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /** Remove an entry from both embeddings and vec_items. */
  remove(id: string): boolean {
    const db = getDb();
    const existing = db
      .query("SELECT rowid FROM embeddings WHERE id = ?")
      .get(id) as { rowid: number } | null;

    if (!existing) return false;

    db.run("DELETE FROM vec_items WHERE rowid = ?", [existing.rowid]);
    db.run("DELETE FROM embeddings WHERE id = ?", [id]);
    return true;
  }

  /** Count total embedded items. */
  count(): number {
    const db = getDb();
    const row = db.query("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number };
    return row.cnt;
  }
}

/** SHA-256 hash of content, truncated to 16 hex chars. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
