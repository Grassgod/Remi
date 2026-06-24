/**
 * clusters CRUD — runtime environments where Remi can be deployed.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";

export interface ClusterRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  protocol: "http" | "https";
  isDefault: boolean;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClusterInput {
  id: string;
  name: string;
  hostname: string;
  port?: number;
  protocol?: "http" | "https";
  isDefault?: boolean;
  description?: string;
}

export function createCluster(
  input: ClusterInput,
  db: Database = getDb(),
): ClusterRow {
  const now = Date.now();
  // If marking default, clear default flag on others
  if (input.isDefault) {
    db.run("UPDATE clusters SET is_default = 0");
  }
  db.run(
    `INSERT INTO clusters (id, name, hostname, port, protocol, is_default, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.name,
      input.hostname,
      input.port ?? 6120,
      input.protocol ?? "http",
      input.isDefault ? 1 : 0,
      input.description ?? null,
      now,
      now,
    ],
  );
  return getCluster(input.id, db)!;
}

export function updateCluster(
  id: string,
  patch: Partial<ClusterInput>,
  db: Database = getDb(),
): ClusterRow | null {
  const existing = getCluster(id, db);
  if (!existing) return null;

  if (patch.isDefault) {
    db.run("UPDATE clusters SET is_default = 0 WHERE id <> ?", [id]);
  }

  const merged = {
    name: patch.name ?? existing.name,
    hostname: patch.hostname ?? existing.hostname,
    port: patch.port ?? existing.port,
    protocol: patch.protocol ?? existing.protocol,
    isDefault: patch.isDefault !== undefined ? patch.isDefault : existing.isDefault,
    description: patch.description ?? existing.description,
  };

  db.run(
    `UPDATE clusters SET
       name = ?, hostname = ?, port = ?, protocol = ?,
       is_default = ?, description = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.name,
      merged.hostname,
      merged.port,
      merged.protocol,
      merged.isDefault ? 1 : 0,
      merged.description,
      Date.now(),
      id,
    ],
  );
  return getCluster(id, db);
}

export function deleteCluster(id: string, db: Database = getDb()): boolean {
  const result = db.run("DELETE FROM clusters WHERE id = ?", [id]);
  return result.changes > 0;
}

export function getCluster(
  id: string,
  db: Database = getDb(),
): ClusterRow | null {
  const row = db
    .query("SELECT * FROM clusters WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? rowToCluster(row) : null;
}

export function listClusters(db: Database = getDb()): ClusterRow[] {
  const rows = db
    .query("SELECT * FROM clusters ORDER BY is_default DESC, id")
    .all() as Record<string, unknown>[];
  return rows.map(rowToCluster);
}

export function getDefaultCluster(
  db: Database = getDb(),
): ClusterRow | null {
  const row = db
    .query("SELECT * FROM clusters WHERE is_default = 1 LIMIT 1")
    .get() as Record<string, unknown> | null;
  return row ? rowToCluster(row) : null;
}

export function countClusters(db: Database = getDb()): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM clusters")
    .get() as { c: number };
  return row.c;
}

function rowToCluster(row: Record<string, unknown>): ClusterRow {
  return {
    id: row.id as string,
    name: row.name as string,
    hostname: row.hostname as string,
    port: Number(row.port),
    protocol: (row.protocol as "http" | "https") ?? "http",
    isDefault: Number(row.is_default) === 1,
    description: (row.description as string) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
