/**
 * access_log — append-only audit table of every auth-checked request.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";

export interface AccessLogEntry {
  id: number;
  ts: number;
  username: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
}

export interface AccessLogInput {
  username?: string | null;
  method: string;
  path: string;
  status: number;
  ip?: string | null;
  userAgent?: string | null;
}

export function appendAccessLog(
  entry: AccessLogInput,
  db: Database = getDb(),
): void {
  db.run(
    `INSERT INTO access_log (ts, username, method, path, status, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      entry.username ?? null,
      entry.method,
      entry.path,
      entry.status,
      entry.ip ?? null,
      entry.userAgent ?? null,
    ],
  );
}

export interface ListOpts {
  limit?: number;
  username?: string;
  sinceMs?: number;
}

export function listAccessLog(
  opts: ListOpts = {},
  db: Database = getDb(),
): AccessLogEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (opts.username) {
    where.push("username = ?");
    params.push(opts.username);
  }
  if (opts.sinceMs) {
    where.push("ts >= ?");
    params.push(opts.sinceMs);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM access_log ${clause} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

function rowToEntry(row: Record<string, unknown>): AccessLogEntry {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    username: (row.username as string) ?? null,
    method: row.method as string,
    path: row.path as string,
    status: Number(row.status),
    ip: (row.ip as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
  };
}
