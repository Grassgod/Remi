/**
 * sso_providers CRUD — one row per configured SSO IdP instance.
 *
 * The `config` column is a JSON blob whose schema is defined by the
 * plugin (`type` field). Core code treats it as opaque.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "../../../db/index.js";

export interface SsoProviderRow {
  id: string;
  type: string;
  name: string;
  icon: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface SsoProviderInput {
  id: string;
  type: string;
  name: string;
  icon?: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  sortOrder?: number;
}

export function createProvider(
  input: SsoProviderInput,
  db: Database = getDb(),
): SsoProviderRow {
  const now = Date.now();
  db.run(
    `INSERT INTO sso_providers (id, type, name, icon, enabled, config, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.type,
      input.name,
      input.icon ?? null,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.config),
      input.sortOrder ?? 100,
      now,
      now,
    ],
  );
  return getProvider(input.id, db)!;
}

export function updateProvider(
  id: string,
  patch: Partial<SsoProviderInput>,
  db: Database = getDb(),
): SsoProviderRow | null {
  const existing = getProvider(id, db);
  if (!existing) return null;

  const merged = {
    type: patch.type ?? existing.type,
    name: patch.name ?? existing.name,
    icon: patch.icon ?? existing.icon,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    config: patch.config ?? existing.config,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
  };

  db.run(
    `UPDATE sso_providers SET
       type = ?, name = ?, icon = ?, enabled = ?, config = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.type,
      merged.name,
      merged.icon,
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.config),
      merged.sortOrder,
      Date.now(),
      id,
    ],
  );
  return getProvider(id, db);
}

export function deleteProvider(id: string, db: Database = getDb()): boolean {
  const result = db.run("DELETE FROM sso_providers WHERE id = ?", [id]);
  return result.changes > 0;
}

export function getProvider(
  id: string,
  db: Database = getDb(),
): SsoProviderRow | null {
  const row = db
    .query("SELECT * FROM sso_providers WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? rowToProvider(row) : null;
}

export function listProviders(
  opts: { enabledOnly?: boolean } = {},
  db: Database = getDb(),
): SsoProviderRow[] {
  const sql = opts.enabledOnly
    ? "SELECT * FROM sso_providers WHERE enabled = 1 ORDER BY sort_order, id"
    : "SELECT * FROM sso_providers ORDER BY sort_order, id";
  const rows = db.query(sql).all() as Record<string, unknown>[];
  return rows.map(rowToProvider);
}

export function countProviders(db: Database = getDb()): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM sso_providers")
    .get() as { c: number };
  return row.c;
}

function rowToProvider(row: Record<string, unknown>): SsoProviderRow {
  return {
    id: row.id as string,
    type: row.type as string,
    name: row.name as string,
    icon: (row.icon as string) ?? null,
    enabled: Number(row.enabled) === 1,
    config: JSON.parse(row.config as string) as Record<string, unknown>,
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
