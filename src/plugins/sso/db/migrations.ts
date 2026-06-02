/**
 * SSO plugin DDL — all tables owned by this plugin.
 * Called by SsoPlugin.migrate(db).
 */

import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  // ── ALTERs first (for existing installs) ────────────────────
  // Add users.role if missing
  try {
    const cols = db
      .query("PRAGMA table_info(users)")
      .all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (cols.length > 0 && !have.has("role")) {
      db.exec(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
      );
    }
  } catch {
    /* users doesn't exist yet — CREATE below will set role */
  }

  db.exec(`
    -- Users (identity from SSO/OIDC)
    CREATE TABLE IF NOT EXISTS users (
      username      TEXT PRIMARY KEY,
      sub           TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL,
      name          TEXT,
      nickname      TEXT,
      picture       TEXT,
      employee_id   TEXT,
      tenant_alias  TEXT,
      operator_type TEXT,
      raw_claims    TEXT,
      role          TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_login_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      is_active     INTEGER NOT NULL DEFAULT 1
    );

    -- Access log: every auth_request call logs here for audit
    CREATE TABLE IF NOT EXISTS access_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      username    TEXT,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_access_log_user_ts ON access_log(username, ts DESC);

    -- User sessions (Remi cookies, separate from Claude CLI sessions)
    CREATE TABLE IF NOT EXISTS user_sessions (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      user_agent    TEXT,
      ip            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_username ON user_sessions(username);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

    -- SSO providers (one row per configured IdP instance, plugin type stored in 'type')
    CREATE TABLE IF NOT EXISTS sso_providers (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      icon        TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      config      TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 100,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- SSO operational settings (key/value singletons)
    CREATE TABLE IF NOT EXISTS sso_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- OAuth state: short-lived (10 min) tokens linking authorize → callback.
    -- Persisted so daemon restart mid-flow doesn't strand active logins.
    CREATE TABLE IF NOT EXISTS oauth_states (
      state         TEXT PRIMARY KEY,
      provider_id   TEXT NOT NULL,
      nonce         TEXT NOT NULL,
      next          TEXT NOT NULL DEFAULT '/',
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

    -- Clusters: runtime environments
    CREATE TABLE IF NOT EXISTS clusters (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      hostname    TEXT NOT NULL,
      port        INTEGER NOT NULL DEFAULT 6120,
      protocol    TEXT NOT NULL DEFAULT 'http',
      is_default  INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
}
