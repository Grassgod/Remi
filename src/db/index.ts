/**
 * SQLite singleton with sqlite-vec extension.
 * DB file: ~/.remi/remi.db
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";

const DB_PATH = join(homedir(), ".remi", "remi.db");

let _db: Database | null = null;

/**
 * Get or create the singleton SQLite database with sqlite-vec loaded.
 */
export function getDb(): Database {
  if (_db) return _db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      metadata TEXT,
      embedded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT,
      user_text TEXT,
      assistant_text TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_key);
    CREATE INDEX IF NOT EXISTS idx_conv_date ON conversations(created_at);
  `);

  // vec_items: sqlite-vec virtual table (1024-dim for voyage-3.5-lite)
  // CREATE VIRTUAL TABLE is not idempotent, so check first
  const exists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'"
  ).get();
  if (!exists) {
    db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[1024])");
  }

  _db = db;
  return db;
}

/**
 * Close the database connection and reset singleton.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── KV helpers ──

export function kvGet(key: string): string | null {
  const db = getDb();
  const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  const db = getDb();
  db.run(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, value]
  );
}

export function kvDelete(key: string): void {
  const db = getDb();
  db.run("DELETE FROM kv WHERE key = ?", [key]);
}
