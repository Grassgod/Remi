/**
 * SQLite singleton with sqlite-vec extension.
 * DB file: ~/.remi/remi.db
 *
 * NOTE: macOS SQLite swap (setCustomSQLite) lives in ./sqlite-custom.ts
 * and MUST be imported at the top of main.ts before any other module.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

let sqliteVec: { load: (db: Database) => void } | null = null;
try {
  sqliteVec = require("sqlite-vec");
} catch {
  // sqlite-vec native binary not available — vector features disabled
}

const DB_PATH = join(homedir(), ".remi", "remi.db");

let _db: Database | null = null;
let _dbPath: string = DB_PATH;

/**
 * Override DB file path (call before first getDb()). Used by tests for isolation.
 */
export function setDbPath(path: string): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _dbPath = path;
}

/**
 * Get or create the singleton SQLite database with sqlite-vec loaded.
 */
export function getDb(): Database {
  if (_db) return _db;

  const dir = dirname(_dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(_dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Load sqlite-vec extension (graceful degradation if unsupported)
  let vecEnabled = false;
  if (sqliteVec) {
    try {
      sqliteVec.load(db);
      vecEnabled = true;
    } catch (err) {
      console.warn(`[db] sqlite-vec load failed (vector search disabled): ${(err as Error).message}`);
    }
  }

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

    -- Mission Board
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      project_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      current_step TEXT DEFAULT 'intake',
      contract TEXT,
      mr_url TEXT,
      mr_status TEXT,
      output_dir TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_duration INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id);
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_missions_thread ON missions(thread_id);

    -- Projects (replaces toml-only storage)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chat_id TEXT,
      repo_url TEXT,
      cwd TEXT,
      pipeline_config TEXT,
      init_status TEXT DEFAULT 'pending',
      init_steps TEXT,
      deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_projects_init_status ON projects(init_status);

    -- Group configs (per-group settings, replaces toml bots/allowed_groups/monitor_groups)
    CREATE TABLE IF NOT EXISTS group_configs (
      chat_id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'global',
      name TEXT DEFAULT '',
      monitor INTEGER DEFAULT 0,
      mission_enabled INTEGER DEFAULT 0,
      reply_mode TEXT DEFAULT 'thread',
      system_prompt TEXT DEFAULT '',
      allowed_tools TEXT DEFAULT '[]',
      add_dirs TEXT DEFAULT '[]',
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_gc_project ON group_configs(project_id);

    CREATE TABLE IF NOT EXISTS skill_feedbacks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      step TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_feedbacks_mission ON skill_feedbacks(mission_id);
    CREATE INDEX IF NOT EXISTS idx_feedbacks_skill ON skill_feedbacks(skill_name);

    -- Session registry (replaces sessions.json)
    CREATE TABLE IF NOT EXISTS sessions (
      session_key   TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      display_name  TEXT NOT NULL UNIQUE,
      cwd           TEXT,
      provider      TEXT,
      mode          TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_active   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      status        TEXT NOT NULL DEFAULT 'active'
    );
  `);

  // vec_items: sqlite-vec virtual table (1024-dim for voyage-3.5-lite)
  if (vecEnabled) {
    const exists = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'"
    ).get();
    if (!exists) {
      db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[1024])");
    }
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
  if (!colNames.has("thread_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN thread_id TEXT");
  }
  if (!colNames.has("user_message")) {
    db.exec("ALTER TABLE conversations ADD COLUMN user_message TEXT");
  }
  if (!colNames.has("session_key")) {
    db.exec("ALTER TABLE conversations ADD COLUMN session_key TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_conv_session_key ON conversations(session_key)");
  }

  // group_configs migrations — add new columns
  try {
    const gcCols = db.query("PRAGMA table_info(group_configs)").all() as Array<{ name: string }>;
    const gcColNames = new Set(gcCols.map((c) => c.name));
    if (gcColNames.size > 0) {
      if (!gcColNames.has("allowed_mcps")) db.exec("ALTER TABLE group_configs ADD COLUMN allowed_mcps TEXT DEFAULT '[]'");
      if (!gcColNames.has("cwd")) db.exec("ALTER TABLE group_configs ADD COLUMN cwd TEXT");
      if (!gcColNames.has("launch_command")) db.exec("ALTER TABLE group_configs ADD COLUMN launch_command TEXT");
      if (!gcColNames.has("mission_enabled")) db.exec("ALTER TABLE group_configs ADD COLUMN mission_enabled INTEGER DEFAULT 0");
      if (!gcColNames.has("inject_chat_context")) db.exec("ALTER TABLE group_configs ADD COLUMN inject_chat_context INTEGER DEFAULT 0");
    }
  } catch {}

  // Missions table migration — add sessions column
  try {
    const msnCols = db.query("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    const msnColNames = new Set(msnCols.map((c) => c.name));
    if (msnColNames.size > 0 && !msnColNames.has("sessions")) {
      db.exec("ALTER TABLE missions ADD COLUMN sessions TEXT DEFAULT '{}'");
    }
  } catch {}

  // Missions table migration — add released_at column
  try {
    const msnCols2 = db.query("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    const msnColNames2 = new Set(msnCols2.map((c) => c.name));
    if (msnColNames2.size > 0 && !msnColNames2.has("released_at")) {
      db.exec("ALTER TABLE missions ADD COLUMN released_at TEXT");
      // Backfill: mark all existing done missions as released
      db.exec("UPDATE missions SET released_at = completed_at WHERE status = 'done' AND completed_at IS NOT NULL");
    }
  } catch {}

  // Projects table migration — add deleted column
  try {
    const projCols = db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const projColNames = new Set(projCols.map((c) => c.name));
    if (projColNames.size > 0 && !projColNames.has("deleted")) {
      db.exec("ALTER TABLE projects ADD COLUMN deleted INTEGER DEFAULT 0");
    }
  } catch {}

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
  threadId?: string;
  userMessage?: string;
  sessionKey?: string;
}

export function insertConversationProcessing(row: ConversationInsert & { cliRoundStart?: string }): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO conversations (status, chat_id, sender_id, connector, message_id, cli_session_id, cli_cwd, cli_round_start, thread_id, user_message, session_key)
     VALUES ('processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.chatId,
      row.senderId ?? null,
      row.connector ?? null,
      row.messageId ?? null,
      row.cliSessionId ?? null,
      row.cliCwd ?? null,
      row.cliRoundStart ?? new Date().toISOString(),
      row.threadId ?? null,
      row.userMessage ?? null,
      row.sessionKey ?? null,
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
