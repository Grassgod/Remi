/**
 * Session registry — CRUD operations backed by SQLite.
 * Replaces the old sessions.json + in-memory Map approach.
 */

import { getDb } from "./index.js";
import { generateUniqueName, getSessionName } from "../session-name.js";

export interface SessionRow {
  session_key: string;
  session_id: string;
  display_name: string;
  cwd: string | null;
  provider: string | null;
  mode: string | null;
  created_at: number;
  last_active: number;
  status: string;
}

// ── Queries (lazily prepared) ───────────────────────────────

function db() { return getDb(); }

// ── Read ────────────────────────────────────────────────────

export function getSession(sessionKey: string): SessionRow | null {
  return db().query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | null;
}

export function getSessionId(sessionKey: string): string | null {
  const row = db().query("SELECT session_id FROM sessions WHERE session_key = ?").get(sessionKey) as { session_id: string } | null;
  return row?.session_id || null; // treat '' as null (cleared session)
}

export function getDisplayName(sessionKey: string): string | null {
  const row = db().query("SELECT display_name FROM sessions WHERE session_key = ?").get(sessionKey) as { display_name: string } | null;
  return row?.display_name ?? null;
}

export function getSessionByName(displayName: string): SessionRow | null {
  return db().query("SELECT * FROM sessions WHERE display_name = ?").get(displayName) as SessionRow | null;
}

export function getSessionsByCwd(cwd: string): SessionRow[] {
  return db().query("SELECT * FROM sessions WHERE cwd = ? ORDER BY session_key").all(cwd) as SessionRow[];
}

export function listActiveSessions(): SessionRow[] {
  return db().query("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_active DESC").all() as SessionRow[];
}

export function listAllSessions(): SessionRow[] {
  return db().query("SELECT * FROM sessions ORDER BY last_active DESC").all() as SessionRow[];
}

export function getAllDisplayNames(): Set<string> {
  const rows = db().query("SELECT display_name FROM sessions").all() as { display_name: string }[];
  return new Set(rows.map(r => r.display_name));
}

// ── Write ───────────────────────────────────────────────────

/**
 * Upsert a session with a new sessionId.
 * Generates a unique display_name if the session is new.
 */
export function upsertSession(sessionKey: string, sessionId: string): string {
  const existing = getSession(sessionKey);
  const now = Date.now();

  if (existing) {
    // Update sessionId + touch last_active
    db().run(
      "UPDATE sessions SET session_id = ?, last_active = ?, status = 'active' WHERE session_key = ?",
      [sessionId, now, sessionKey],
    );
    return existing.display_name;
  }

  // New session — generate unique name
  const taken = getAllDisplayNames();
  const displayName = generateUniqueName(sessionId, taken);

  db().run(
    `INSERT INTO sessions (session_key, session_id, display_name, created_at, last_active, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [sessionKey, sessionId, displayName, now, now],
  );
  return displayName;
}

export function updateSessionCwd(sessionKey: string, cwd: string | null): void {
  db().run("UPDATE sessions SET cwd = ?, last_active = ? WHERE session_key = ?", [cwd, Date.now(), sessionKey]);
}

export function updateSessionProvider(sessionKey: string, provider: string | null): void {
  db().run("UPDATE sessions SET provider = ?, last_active = ? WHERE session_key = ?", [provider, Date.now(), sessionKey]);
}

export function updateSessionMode(sessionKey: string, mode: string | null): void {
  db().run("UPDATE sessions SET mode = ?, last_active = ? WHERE session_key = ?", [mode, Date.now(), sessionKey]);
}

export function upsertSessionSettings(
  sessionKey: string,
  settings: { provider?: string | null; mode?: string | null; clearSessionId?: boolean },
): string {
  const existing = getSession(sessionKey);
  const now = Date.now();

  if (existing) {
    db().run(
      `UPDATE sessions
       SET provider = ?, mode = ?, session_id = ?, last_active = ?, status = 'active'
      WHERE session_key = ?`,
      [
        settings.provider === undefined ? existing.provider : settings.provider,
        settings.mode === undefined ? existing.mode : settings.mode,
        settings.clearSessionId ? "" : existing.session_id,
        now,
        sessionKey,
      ],
    );
    return existing.display_name;
  }

  const taken = getAllDisplayNames();
  const displayName = generateUniqueName(sessionKey, taken);
  db().run(
    `INSERT INTO sessions (session_key, session_id, display_name, provider, mode, created_at, last_active, status)
     VALUES (?, '', ?, ?, ?, ?, ?, 'active')`,
    [sessionKey, displayName, settings.provider ?? null, settings.mode ?? null, now, now],
  );
  return displayName;
}

export function touchSession(sessionKey: string): void {
  db().run("UPDATE sessions SET last_active = ? WHERE session_key = ?", [Date.now(), sessionKey]);
}

export function deleteSession(sessionKey: string): void {
  db().run("DELETE FROM sessions WHERE session_key = ?", [sessionKey]);
}

export function clearSessionId(sessionKey: string): void {
  // Keep the row (preserve display_name) but clear session_id for new conversation
  db().run(
    "UPDATE sessions SET session_id = '', last_active = ? WHERE session_key = ?",
    [Date.now(), sessionKey],
  );
}

export interface EnsureTopicSessionBindingResult {
  row: SessionRow;
  bound: boolean;
}

/** Bind a new/unbound persistent session to one topic directory. */
export function ensureTopicSessionBinding(
  sessionKey: string,
  topicCwd: string,
): EnsureTopicSessionBindingResult {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | null;
    if (existing?.cwd && existing.cwd !== topicCwd) {
      database.exec("COMMIT");
      return { row: existing, bound: false };
    }
    const owners = database.query(
      "SELECT session_key FROM sessions WHERE cwd = ? AND session_key != ?",
    ).all(topicCwd, sessionKey) as Array<{ session_key: string }>;
    if (owners.length > 0) {
      throw new Error(`Topic workspace ${topicCwd} is already bound to session ${owners[0]!.session_key}`);
    }
    const now = Date.now();
    if (existing) {
      if (existing.cwd === topicCwd) {
        database.run(
          "UPDATE sessions SET last_active = ?, status = 'active' WHERE session_key = ?",
          [now, sessionKey],
        );
      } else {
        database.run(
          "UPDATE sessions SET cwd = ?, session_id = '', last_active = ?, status = 'active' WHERE session_key = ?",
          [topicCwd, now, sessionKey],
        );
      }
    } else {
      const taken = new Set(
        (database.query("SELECT display_name FROM sessions").all() as Array<{ display_name: string }>)
          .map((entry) => entry.display_name),
      );
      const displayName = generateUniqueName(sessionKey, taken);
      database.run(
        `INSERT INTO sessions (session_key, session_id, display_name, cwd, created_at, last_active, status)
         VALUES (?, '', ?, ?, ?, ?, 'active')`,
        [sessionKey, displayName, topicCwd, now, now],
      );
    }
    const row = database.query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow;
    database.exec("COMMIT");
    return { row, bound: true };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/** Atomically move a session binding and reset its provider session. */
export function moveSessionCwdAndClearId(
  sessionKey: string,
  expectedCwd: string,
  nextCwd: string,
): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const owners = database.query("SELECT session_key FROM sessions WHERE cwd = ?").all(expectedCwd) as Array<{ session_key: string }>;
    if (owners.length !== 1 || owners[0]!.session_key !== sessionKey) {
      throw new Error(
        `Expected topic session ${sessionKey} to be the sole owner of ${expectedCwd}; found ${owners.map((row) => row.session_key).join(", ") || "none"}`,
      );
    }
    database.run(
      "UPDATE sessions SET cwd = ?, session_id = '', last_active = ?, status = 'active' WHERE session_key = ?",
      [nextCwd, Date.now(), sessionKey],
    );
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/** Move a binding when it still points at the Issue; preserve explicit user overrides. */
export function returnSessionToTopic(
  sessionKey: string,
  issueCwd: string,
  topicCwd: string,
): "moved" | "missing" | "overridden" {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | null;
    if (!row) {
      database.exec("COMMIT");
      return "missing";
    }
    if (row.cwd !== issueCwd) {
      database.exec("COMMIT");
      return "overridden";
    }
    const owners = database.query(
      "SELECT session_key FROM sessions WHERE cwd = ? AND session_key != ?",
    ).all(topicCwd, sessionKey) as Array<{ session_key: string }>;
    if (owners.length > 0) {
      throw new Error(`Topic workspace ${topicCwd} is already bound to session ${owners[0]!.session_key}`);
    }
    database.run(
      "UPDATE sessions SET cwd = ?, session_id = '', last_active = ?, status = 'active' WHERE session_key = ?",
      [topicCwd, Date.now(), sessionKey],
    );
    database.exec("COMMIT");
    return "moved";
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

// ── Migration from sessions.json ────────────────────────────

export interface LegacySessionData {
  entries?: [string, string][];
  cwdMap?: [string, string][];
  providerMap?: [string, string][];
  modeMap?: [string, string][];
  savedAt?: number;
}

/**
 * Migrate legacy sessions.json data into the DB.
 * Generates unique display names for all entries.
 */
export function migrateFromJson(data: LegacySessionData): number {
  const taken = getAllDisplayNames();
  const cwdLookup = new Map(data.cwdMap ?? []);
  const providerLookup = new Map(data.providerMap ?? []);
  const modeLookup = new Map(data.modeMap ?? []);
  const now = Date.now();

  const insert = db().prepare(
    `INSERT OR IGNORE INTO sessions (session_key, session_id, display_name, cwd, provider, mode, created_at, last_active, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  );

  let count = 0;
  const tx = db().transaction(() => {
    for (const [key, id] of data.entries ?? []) {
      if (!id) continue;
      const displayName = generateUniqueName(id, taken);
      taken.add(displayName);
      insert.run(
        key, id, displayName,
        cwdLookup.get(key) ?? null,
        providerLookup.get(key) ?? null,
        modeLookup.get(key) ?? null,
        data.savedAt ?? now, data.savedAt ?? now,
      );
      count++;
    }
  });
  tx();

  return count;
}
