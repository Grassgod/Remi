#!/usr/bin/env bun
/**
 * Migrate Multiremi data from the local SQLite store into a Postgres backend.
 *
 *   MULTIREMI_DATABASE_URL=postgres://… bun run scripts/migrate-sqlite-to-pg.ts [sqlite-path]
 *
 * Source: the SQLite file (default ~/.remi/remi.db). Target: the Postgres db in
 * MULTIREMI_DATABASE_URL. The target schema is created by MultiremiStore.migrate()
 * (same multiremi_* tables, Postgres-translated). Every `multiremi_*` table is
 * copied row-for-row. Existing target rows in each copied table are replaced.
 */
import "@shared/db/sqlite-custom.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { PostgresSyncDatabase, isPostgresConfigured } from "@multiremi/sql-database.js";
import { MultiremiStore } from "@multiremi/store.js";

const sqlitePath = process.argv[2] ?? join(homedir(), ".remi", "remi.db");
const pgUrl = process.env.MULTIREMI_DATABASE_URL ?? "";
if (!isPostgresConfigured()) {
  console.error("Set MULTIREMI_DATABASE_URL=postgres://… to choose the target database.");
  process.exit(1);
}

const src = new Database(sqlitePath, { readonly: true });
const pg = new PostgresSyncDatabase(pgUrl);
new MultiremiStore(pg); // creates the multiremi_* schema on Postgres

const tables = (src.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'multiremi_%' ORDER BY name").all() as { name: string }[])
  .map((r) => r.name);

let totalRows = 0;
let copiedTables = 0;
for (const table of tables) {
  const cols = (src.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const rows = src.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  // Target table must exist (created by migrate()); skip sqlite-only tables.
  const exists = pg.query(
    "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema='public' AND table_name = ?",
  ).get(table);
  if (!exists) { console.log(`skip ${table} (no target table)`); continue; }

  pg.run(`DELETE FROM ${table}`);
  if (rows.length) {
    const colList = cols.join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const insert = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
    const tx = pg.transaction(() => {
      for (const row of rows) pg.run(insert, cols.map((c) => row[c] ?? null));
    });
    tx();
  }
  totalRows += rows.length;
  copiedTables++;
  console.log(`copied ${String(rows.length).padStart(5)} rows → ${table}`);
}

console.log(`\n✅ migrated ${totalRows} rows across ${copiedTables} tables from ${sqlitePath} → Postgres`);
src.close();
pg.close();
process.exit(0);
