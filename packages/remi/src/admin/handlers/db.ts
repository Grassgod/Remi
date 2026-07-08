/**
 * Database API handler.
 * Exposes SQLite + sqlite-vec metrics, schema browsing, and SQL execution for the dashboard.
 */

import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb, kvSet, kvDelete } from "@shared/db/index.js";

export function registerDbHandlers(app: Hono, _data: RemiData) {
  // GET /api/v1/db/stats — Enhanced overview stats
  app.get("/api/v1/db/stats", (c) => {
    const db = getDb();

    const dbSize = db.query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const sqliteVersion = (db.query("SELECT sqlite_version() as v").get() as { v: string }).v;

    // Discover all tables
    const allTables = db.query(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string; type: string }>;

    const tables = allTables.map((t) => {
      let rowCount = 0;
      try {
        rowCount = (db.query(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number }).cnt;
      } catch { /* virtual tables may fail */ }
      return {
        name: t.name,
        rowCount,
        type: t.type === "table" ? (t.name === "vec_items" ? "virtual" : "table") : t.type,
      };
    });

    // Check if vec_items exists (indicates sqlite-vec is loaded)
    const vecEnabled = allTables.some((t) => t.name === "vec_items");

    return c.json({
      dbPath: "~/.remi/remi.db",
      dbSizeBytes: dbSize.size,
      journalMode,
      sqliteVersion,
      vecEnabled,
      tables,
      totalTables: tables.length,
      totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0),
    });
  });

  // GET /api/v1/db/schema — Full schema metadata
  app.get("/api/v1/db/schema", (c) => {
    const db = getDb();

    const allTables = db.query(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string; type: string; sql: string }>;

    const tables = allTables.map((t) => {
      const isVirtual = t.sql?.toUpperCase().includes("CREATE VIRTUAL TABLE");

      // Columns (PRAGMA table_info fails on virtual tables)
      let columns: Array<{ cid: number; name: string; type: string; notnull: boolean; dflt_value: string | null; pk: boolean }> = [];
      if (!isVirtual) {
        try {
          const rawCols = db.query(`PRAGMA table_info("${t.name}")`).all() as Array<{
            cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
          }>;
          columns = rawCols.map((col) => ({
            cid: col.cid,
            name: col.name,
            type: col.type,
            notnull: col.notnull === 1,
            dflt_value: col.dflt_value,
            pk: col.pk > 0,
          }));
        } catch { /* skip */ }
      }

      // Indexes
      let indexes: Array<{ name: string; unique: boolean; columns: string[]; sql: string | null }> = [];
      try {
        const rawIndexes = db.query(`PRAGMA index_list("${t.name}")`).all() as Array<{
          name: string; unique: number; origin: string;
        }>;
        indexes = rawIndexes.map((idx) => {
          const idxCols = db.query(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
          const idxSql = db.query(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name=?"
          ).get(idx.name) as { sql: string | null } | null;
          return {
            name: idx.name,
            unique: idx.unique === 1,
            columns: idxCols.map((ic) => ic.name),
            sql: idxSql?.sql ?? null,
          };
        });
      } catch { /* skip */ }

      return {
        name: t.name,
        type: isVirtual ? "virtual" as const : "table" as const,
        sql: t.sql || "",
        columns,
        indexes,
      };
    });

    return c.json({ tables });
  });

  // GET /api/v1/db/tables/:tableName — Browse table data with pagination
  app.get("/api/v1/db/tables/:tableName", (c) => {
    const db = getDb();
    const tableName = c.req.param("tableName");

    // Validate table exists (prevent injection)
    const exists = db.query(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?"
    ).get(tableName);
    if (!exists) {
      return c.json({ error: `Table "${tableName}" not found` }, 404);
    }

    // Check if it's a virtual table with blob data
    const tableSql = (db.query(
      "SELECT sql FROM sqlite_master WHERE name = ?"
    ).get(tableName) as { sql: string } | null)?.sql || "";
    if (tableSql.toUpperCase().includes("CREATE VIRTUAL TABLE")) {
      return c.json({ error: "Virtual table browsing not supported" }, 400);
    }

    const limit = Math.min(Number(c.req.query("limit")) || 50, 500);
    const offset = Number(c.req.query("offset")) || 0;
    const orderDir = c.req.query("orderDir") === "asc" ? "ASC" : "DESC";

    // Validate orderBy column
    let orderBy = c.req.query("orderBy") || "rowid";
    if (orderBy !== "rowid") {
      const cols = db.query(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((col) => col.name));
      if (!colNames.has(orderBy)) {
        orderBy = "rowid";
      }
    }

    const total = (db.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;
    const rows = db.query(`SELECT * FROM "${tableName}" ORDER BY "${orderBy}" ${orderDir} LIMIT ? OFFSET ?`).all(limit, offset);
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];

    return c.json({ tableName, columns, rows, total, limit, offset });
  });

  // POST /api/v1/db/query — Execute arbitrary SQL
  app.post("/api/v1/db/query", async (c) => {
    const body = await c.req.json<{ sql: string; params?: unknown[]; readOnly?: boolean }>();
    const { sql, params = [], readOnly = true } = body;

    if (!sql?.trim()) {
      return c.json({ error: "SQL query is required" }, 400);
    }

    const db = getDb();
    const start = performance.now();

    // Read-only guard
    const trimmed = sql.trim();
    const isRead = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);
    if (readOnly && !isRead) {
      return c.json({
        error: "Write operations disabled in read-only mode. Toggle read-only off to execute write queries.",
        executionMs: performance.now() - start,
      });
    }

    try {
      if (isRead) {
        const allRows = db.query(sql).all(...(params as any[]));
        const columns = allRows.length > 0 ? Object.keys(allRows[0] as object) : [];
        const truncated = allRows.length > 1000;
        const capped = truncated ? allRows.slice(0, 1000) : allRows;
        return c.json({
          columns,
          rows: capped.map((r) => columns.map((col) => (r as any)[col])),
          rowCount: capped.length,
          truncated,
          executionMs: performance.now() - start,
          type: "query",
        });
      } else {
        const result = db.run(sql, ...(params as any[]));
        return c.json({
          columns: [],
          rows: [],
          rowCount: 0,
          changes: result.changes,
          executionMs: performance.now() - start,
          type: "execute",
        });
      }
    } catch (err) {
      return c.json({
        error: (err as Error).message,
        executionMs: performance.now() - start,
      });
    }
  });

  // GET /api/v1/db/kv — List all KV entries
  app.get("/api/v1/db/kv", (c) => {
    const db = getDb();
    const rows = db.query("SELECT key, value, updated_at FROM kv ORDER BY updated_at DESC").all() as Array<{
      key: string; value: string; updated_at: string;
    }>;
    return c.json(rows);
  });

  // GET /api/v1/db/embeddings — List all embedding entries
  app.get("/api/v1/db/embeddings", (c) => {
    const db = getDb();
    const rows = db.query("SELECT id, content_hash, metadata, embedded_at FROM embeddings ORDER BY embedded_at DESC").all() as Array<{
      id: string; content_hash: string; metadata: string | null; embedded_at: string;
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
