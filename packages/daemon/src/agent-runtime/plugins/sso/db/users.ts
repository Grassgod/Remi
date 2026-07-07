/**
 * users + user_sessions CRUD helpers.
 *
 * - users:         identity from SSO/OIDC (username = primary key)
 * - user_sessions: Remi-issued session cookies (separate from Claude CLI sessions)
 */

import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";

export type UserRole = "admin" | "member";

export interface User {
  username: string;
  sub: string;
  email: string;
  name: string | null;
  nickname: string | null;
  picture: string | null;
  employeeId: string | null;
  tenantAlias: string | null;
  operatorType: string | null;
  rawClaims: Record<string, unknown> | null;
  role: UserRole;
  createdAt: number;
  lastLoginAt: number;
  isActive: boolean;
}

export interface UserSession {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  ip: string | null;
}

/** OIDC claims used to upsert a user. */
export interface OidcClaims {
  sub: string;
  username?: string;
  email: string;
  name?: string;
  nickname?: string;
  picture?: string;
  employee_id?: string;
  tenant_alias?: string;
  operator_type?: string;
  [key: string]: unknown;
}

// ── Users ──────────────────────────────────────────────────────

export interface UpsertOptions {
  /** Emails in this list are auto-promoted to admin on first INSERT.
   *  Existing users' roles are NOT changed (use setUserRole). */
  adminEmails?: string[];
}

/**
 * Create-or-update a user from OIDC claims.
 * Username defaults to claim.username; falls back to email prefix.
 */
export function upsertUser(
  claims: OidcClaims,
  opts: UpsertOptions = {},
  db: Database = getDb(),
): User {
  const username = (claims.username ?? claims.email.split("@")[0]).trim();
  if (!username) throw new Error("upsertUser: cannot derive username from claims");

  const now = Date.now();
  const existing = db
    .query("SELECT * FROM users WHERE username = ?")
    .get(username) as Record<string, unknown> | null;

  if (existing) {
    // Don't touch role on update — preserve whatever admin set
    db.run(
      `UPDATE users SET
         sub = ?, email = ?, name = ?, nickname = ?, picture = ?,
         employee_id = ?, tenant_alias = ?, operator_type = ?,
         raw_claims = ?, last_login_at = ?, is_active = 1
       WHERE username = ?`,
      [
        claims.sub,
        claims.email,
        claims.name ?? null,
        claims.nickname ?? null,
        claims.picture ?? null,
        claims.employee_id ?? null,
        claims.tenant_alias ?? null,
        claims.operator_type ?? null,
        JSON.stringify(claims),
        now,
        username,
      ],
    );
  } else {
    // New user — pick role from adminEmails bootstrap list
    const adminList = (opts.adminEmails ?? []).map((e) =>
      e.trim().toLowerCase(),
    );
    const role: UserRole = adminList.includes(claims.email.toLowerCase())
      ? "admin"
      : "member";

    db.run(
      `INSERT INTO users (
         username, sub, email, name, nickname, picture,
         employee_id, tenant_alias, operator_type, raw_claims,
         role, created_at, last_login_at, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        username,
        claims.sub,
        claims.email,
        claims.name ?? null,
        claims.nickname ?? null,
        claims.picture ?? null,
        claims.employee_id ?? null,
        claims.tenant_alias ?? null,
        claims.operator_type ?? null,
        JSON.stringify(claims),
        role,
        now,
        now,
      ],
    );
  }

  return getUserByUsername(username, db)!;
}

export function setUserRole(
  username: string,
  role: UserRole,
  db: Database = getDb(),
): void {
  db.run("UPDATE users SET role = ? WHERE username = ?", [role, username]);
}

export function getUserByUsername(
  username: string,
  db: Database = getDb(),
): User | null {
  const row = db
    .query("SELECT * FROM users WHERE username = ?")
    .get(username) as Record<string, unknown> | null;
  return row ? rowToUser(row) : null;
}

export function listUsers(db: Database = getDb()): User[] {
  const rows = db
    .query("SELECT * FROM users ORDER BY last_login_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToUser);
}

export function setUserActive(
  username: string,
  active: boolean,
  db: Database = getDb(),
): void {
  db.run("UPDATE users SET is_active = ? WHERE username = ?", [
    active ? 1 : 0,
    username,
  ]);
}

// ── Sessions ───────────────────────────────────────────────────

/** Create a new session token for a user. Returns the id (cookie value). */
export function createSession(
  username: string,
  ttlSeconds: number,
  userAgent?: string,
  ip?: string,
  db: Database = getDb(),
): UserSession {
  const id = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  db.run(
    `INSERT INTO user_sessions (id, username, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, username, now, expiresAt, now, userAgent ?? null, ip ?? null],
  );
  return {
    id,
    username,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: userAgent ?? null,
    ip: ip ?? null,
  };
}

/** Look up a session by id. Returns null if not found or expired. */
export function getSession(
  id: string,
  db: Database = getDb(),
): UserSession | null {
  const row = db
    .query("SELECT * FROM user_sessions WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  if (!row) return null;
  const s = rowToSession(row);
  if (Date.now() > s.expiresAt) {
    deleteSession(id, db);
    return null;
  }
  return s;
}

/** Update last_seen_at — call on every authenticated request. */
export function touchSession(id: string, db: Database = getDb()): void {
  db.run("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
}

export function deleteSession(id: string, db: Database = getDb()): void {
  db.run("DELETE FROM user_sessions WHERE id = ?", [id]);
}

export function deleteSessionsForUser(
  username: string,
  db: Database = getDb(),
): void {
  db.run("DELETE FROM user_sessions WHERE username = ?", [username]);
}

/** Sweep expired sessions. Call from a cron job. */
export function sweepExpiredSessions(db: Database = getDb()): number {
  const result = db.run(
    "DELETE FROM user_sessions WHERE expires_at < ?",
    [Date.now()],
  );
  return result.changes;
}

// ── Row mapping ────────────────────────────────────────────────

function rowToUser(row: Record<string, unknown>): User {
  return {
    username: row.username as string,
    sub: row.sub as string,
    email: row.email as string,
    name: (row.name as string) ?? null,
    nickname: (row.nickname as string) ?? null,
    picture: (row.picture as string) ?? null,
    employeeId: (row.employee_id as string) ?? null,
    tenantAlias: (row.tenant_alias as string) ?? null,
    operatorType: (row.operator_type as string) ?? null,
    rawClaims: row.raw_claims
      ? (JSON.parse(row.raw_claims as string) as Record<string, unknown>)
      : null,
    role: ((row.role as string) ?? "member") as UserRole,
    createdAt: Number(row.created_at),
    lastLoginAt: Number(row.last_login_at),
    isActive: Number(row.is_active) === 1,
  };
}

function rowToSession(row: Record<string, unknown>): UserSession {
  return {
    id: row.id as string,
    username: row.username as string,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
    userAgent: (row.user_agent as string) ?? null,
    ip: (row.ip as string) ?? null,
  };
}
