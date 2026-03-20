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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Status tracking (two-phase: processing → completed/failed)
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      -- Remi business context (CLI doesn't know these)
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      connector TEXT,
      message_id TEXT,
      card_id TEXT,
      cost_usd REAL,
      duration_ms INTEGER,
      -- CLI correlation
      cli_session_id TEXT,
      cli_cwd TEXT,
      cli_round_start TEXT,
      cli_round_end TEXT,
      cli_message_ids TEXT,    -- JSON array of msg_xxx from CLI stdout
      -- Summary (avoid reading JSONL for common queries)
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      -- Remi processing steps (extensible JSON array)
      spans TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversations(chat_id);
    CREATE INDEX IF NOT EXISTS idx_conv_date ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_sender ON conversations(sender_id);
    CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status) WHERE status != 'completed';
  `);

  // vec_items: sqlite-vec virtual table (1024-dim for voyage-3.5-lite)
  // CREATE VIRTUAL TABLE is not idempotent, so check first
  const exists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'"
  ).get();
  if (!exists) {
    db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[1024])");
  }

  // ── Migrations: add new columns to conversations if missing ──
  const colCheck = db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const colNames = new Set(colCheck.map(c => c.name));
  if (!colNames.has("cli_round_start")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cli_round_start TEXT");
  }
  if (!colNames.has("cli_round_end")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cli_round_end TEXT");
  }
  if (!colNames.has("cli_message_ids")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cli_message_ids TEXT");
  }
  if (!colNames.has("cache_create_tokens")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cache_create_tokens INTEGER");
  }
  if (!colNames.has("cache_read_tokens")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cache_read_tokens INTEGER");
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

// ── Conversations helpers ──

/** Phase 1: Insert a "processing" record when message arrives. Returns row id. */
export interface ConversationInsert {
  chatId: string;
  senderId?: string;
  connector?: string;
  messageId?: string;
  cliSessionId?: string;
  cliCwd?: string;
}

export function insertConversationProcessing(row: ConversationInsert & { cliRoundStart?: string }): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO conversations (status, chat_id, sender_id, connector, message_id, cli_session_id, cli_cwd, cli_round_start)
     VALUES ('processing', ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.chatId,
      row.senderId ?? null,
      row.connector ?? null,
      row.messageId ?? null,
      row.cliSessionId ?? null,
      row.cliCwd ?? null,
      row.cliRoundStart ?? new Date().toISOString(),
    ],
  );
  return Number(result.lastInsertRowid);
}

/** Phase 2a: Update to "completed" with full results. */
export interface ConversationComplete {
  id: number;
  cardId?: string;
  costUsd?: number;
  durationMs?: number;
  cliSessionId?: string;
  cliRoundEnd?: string;
  cliMessageIds?: string[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
  spans?: unknown[];
}

export function completeConversation(row: ConversationComplete): void {
  const db = getDb();
  db.run(
    `UPDATE conversations SET
      status = 'completed',
      card_id = ?, cost_usd = ?, duration_ms = ?,
      cli_session_id = COALESCE(?, cli_session_id),
      cli_round_end = ?,
      cli_message_ids = ?,
      model = ?, input_tokens = ?, output_tokens = ?,
      cache_create_tokens = ?, cache_read_tokens = ?,
      spans = ?
     WHERE id = ?`,
    [
      row.cardId ?? null,
      row.costUsd ?? null,
      row.durationMs ?? null,
      row.cliSessionId ?? null,
      row.cliRoundEnd ?? new Date().toISOString(),
      row.cliMessageIds ? JSON.stringify(row.cliMessageIds) : null,
      row.model ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.cacheCreateTokens ?? null,
      row.cacheReadTokens ?? null,
      row.spans ? JSON.stringify(row.spans) : null,
      row.id,
    ],
  );
}

/** Phase 2b: Update to "failed" with error message. */
export function failConversation(id: number, error: string, durationMs?: number): void {
  const db = getDb();
  db.run(
    `UPDATE conversations SET status = 'failed', error = ?, duration_ms = ? WHERE id = ?`,
    [error, durationMs ?? null, id],
  );
}
