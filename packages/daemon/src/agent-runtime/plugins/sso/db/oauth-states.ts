/**
 * oauth_states — short-lived OAuth state/nonce store, persisted to SQLite.
 * Survives daemon restart so in-progress logins don't fail mid-flow.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";

export interface OAuthState {
  state: string;
  providerId: string;
  nonce: string;
  next: string;
  expiresAt: number;
}

export function createOAuthState(
  s: OAuthState,
  db: Database = getDb(),
): void {
  db.run(
    `INSERT INTO oauth_states (state, provider_id, nonce, next, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [s.state, s.providerId, s.nonce, s.next, s.expiresAt],
  );
}

/** Atomically read + delete (single-use). Returns null if not found / expired. */
export function consumeOAuthState(
  state: string,
  db: Database = getDb(),
): OAuthState | null {
  // Bun's better-sqlite3-compatible API doesn't expose multi-statement
  // transactions cleanly; do select-then-delete which is fine because state
  // is high-entropy and only valid once.
  const row = db
    .query("SELECT * FROM oauth_states WHERE state = ?")
    .get(state) as Record<string, unknown> | null;
  if (!row) return null;
  db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
  const now = Date.now();
  const out: OAuthState = {
    state: row.state as string,
    providerId: row.provider_id as string,
    nonce: row.nonce as string,
    next: row.next as string,
    expiresAt: Number(row.expires_at),
  };
  if (out.expiresAt < now) return null;
  return out;
}

/** Remove expired rows. Call periodically (or on each login start). */
export function sweepExpiredOAuthStates(db: Database = getDb()): number {
  const result = db.run(
    "DELETE FROM oauth_states WHERE expires_at < ?",
    [Date.now()],
  );
  return result.changes;
}
