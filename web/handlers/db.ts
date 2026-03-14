/**
 * Database stats API handler.
 * Exposes SQLite + sqlite-vec metrics for the dashboard.
 */

import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb, kvGet, kvSet, kvDelete } from "../../src/db/index.js";

export function registerDbHandlers(app: Hono, _data: RemiData) {
  // GET /api/v1/db/stats — Overview stats
  app.get("/api/v1/db/stats", (c) => {
    const db = getDb();

    const kvCount = (db.query("SELECT COUNT(*) as cnt FROM kv").get() as { cnt: number }).cnt;
    const embeddingCount = (db.query("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }).cnt;

    // DB file size
    const dbSize = db.query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };

    // WAL mode check
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;

    return c.json({
      dbPath: "~/.remi/remi.db",
      dbSizeBytes: dbSize.size,
      journalMode,
      tables: {
        kv: { count: kvCount },
        embeddings: { count: embeddingCount },
      },
    });
  });

  // GET /api/v1/db/kv — List all KV entries
  app.get("/api/v1/db/kv", (c) => {
    const db = getDb();
    const rows = db.query("SELECT key, value, updated_at FROM kv ORDER BY updated_at DESC").all() as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    return c.json(rows);
  });

  // GET /api/v1/db/embeddings — List all embedding entries
  app.get("/api/v1/db/embeddings", (c) => {
    const db = getDb();
    const rows = db.query("SELECT id, content_hash, metadata, embedded_at FROM embeddings ORDER BY embedded_at DESC").all() as Array<{
      id: string;
      content_hash: string;
      metadata: string | null;
      embedded_at: string;
    }>;
    return c.json(
      rows.map((r) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      })),
    );
  });

  // POST /api/v1/db/kv — Set a KV entry
  app.post("/api/v1/db/kv", async (c) => {
    const { key, value } = await c.req.json<{ key: string; value: string }>();
    if (!key) return c.json({ error: "key is required" }, 400);
    kvSet(key, value);
    return c.json({ ok: true });
  });

  // DELETE /api/v1/db/kv/:key — Delete a KV entry
  app.delete("/api/v1/db/kv/:key", (c) => {
    const key = c.req.param("key");
    kvDelete(key);
    return c.json({ ok: true });
  });
}
