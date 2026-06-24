/**
 * Typed DB access for config-hub:
 *  - GlobalMcpDao   → config-hub.db `mcp_servers` (global cross-tool layer)
 *  - ProjectMcpDao  → Remi main DB `config_hub_project_mcp` (Remi-only project overlay)
 *  - SqliteManifestStore → Remi main DB `config_hub_manifest` (implements ManifestStore)
 *
 * Per-tool enabled flags are surfaced as separate fields rather than a generic
 * apps map, so the SQL stays simple and maps 1:1 onto the table columns.
 */

import type { Database } from "bun:sqlite";
import type { AppType, EntryMap, Manifest, McpConfig } from "../types.js";
import type { ManifestStore } from "../../mcp/sync.js";

export interface McpRow {
  id: string;
  name: string;
  config: McpConfig;
  description: string | null;
  enabled: Record<AppType, boolean>;
}

function rowToMcp(r: {
  id: string;
  name: string;
  server_config: string;
  description: string | null;
  enabled_claude: number;
  enabled_codex: number;
  enabled_gemini: number;
}): McpRow {
  return {
    id: r.id,
    name: r.name,
    config: JSON.parse(r.server_config) as McpConfig,
    description: r.description ?? null,
    enabled: {
      claude: !!r.enabled_claude,
      codex: !!r.enabled_codex,
      gemini: !!r.enabled_gemini,
    },
  };
}

export class GlobalMcpDao {
  constructor(private readonly db: Database) {}

  list(): McpRow[] {
    const rows = this.db
      .query(
        `SELECT id, name, server_config, description,
                enabled_claude, enabled_codex, enabled_gemini
         FROM mcp_servers`,
      )
      .all() as any[];
    return rows.map(rowToMcp);
  }

  /** Return name→config for servers enabled for `app` (used as `ours` in sync). */
  enabledFor(app: AppType): EntryMap {
    const col = `enabled_${app}`;
    const rows = this.db
      .query(`SELECT name, server_config FROM mcp_servers WHERE ${col} = 1`)
      .all() as { name: string; server_config: string }[];
    const out: EntryMap = {};
    for (const r of rows) out[r.name] = JSON.parse(r.server_config) as McpConfig;
    return out;
  }

  upsert(row: {
    id: string;
    name: string;
    config: McpConfig;
    description?: string;
    enabled: Partial<Record<AppType, boolean>>;
  }): void {
    this.db.run(
      `INSERT INTO mcp_servers
         (id, name, server_config, description,
          enabled_claude, enabled_codex, enabled_gemini)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         server_config=excluded.server_config,
         description=excluded.description,
         enabled_claude=excluded.enabled_claude,
         enabled_codex=excluded.enabled_codex,
         enabled_gemini=excluded.enabled_gemini`,
      [
        row.id,
        row.name,
        JSON.stringify(row.config),
        row.description ?? "",
        row.enabled.claude ? 1 : 0,
        row.enabled.codex ? 1 : 0,
        row.enabled.gemini ? 1 : 0,
      ],
    );
  }

  /** Upsert by name (used by reconcile imports — name is the identity in tool files). */
  upsertByName(name: string, config: McpConfig, app: AppType): void {
    const existing = this.db
      .query(`SELECT id FROM mcp_servers WHERE name = ? LIMIT 1`)
      .get(name) as { id: string } | null;
    if (existing) {
      this.db.run(
        `UPDATE mcp_servers
           SET server_config = ?, enabled_${app} = 1
         WHERE id = ?`,
        [JSON.stringify(config), existing.id],
      );
    } else {
      // Use name as id when caller didn't supply one (import path).
      this.upsert({ id: name, name, config, enabled: { [app]: true } });
    }
  }

  setEnabled(id: string, app: AppType, enabled: boolean): void {
    this.db.run(`UPDATE mcp_servers SET enabled_${app} = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
  }

  setEnabledByName(name: string, app: AppType, enabled: boolean): void {
    this.db.run(`UPDATE mcp_servers SET enabled_${app} = ? WHERE name = ?`, [
      enabled ? 1 : 0,
      name,
    ]);
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM mcp_servers WHERE id = ?`, [id]);
  }
}

export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  directory: string;
  contentHash: string | null;
  installedAt: number;
  updatedAt: number;
  enabled: Record<AppType, boolean>;
}

export class SkillsDao {
  constructor(private readonly db: Database) {}

  list(): SkillRow[] {
    const rows = this.db
      .query(
        `SELECT id, name, description, directory, content_hash, installed_at, updated_at,
                enabled_claude, enabled_codex, enabled_gemini
         FROM skills`,
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      directory: r.directory,
      contentHash: r.content_hash ?? null,
      installedAt: r.installed_at ?? 0,
      updatedAt: r.updated_at ?? 0,
      enabled: {
        claude: !!r.enabled_claude,
        codex: !!r.enabled_codex,
        gemini: !!r.enabled_gemini,
      },
    }));
  }

  get(id: string): SkillRow | null {
    const all = this.list().filter((s) => s.id === id);
    return all[0] ?? null;
  }

  upsert(row: {
    id: string;
    name: string;
    description?: string;
    directory: string;
    contentHash?: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO skills
         (id, name, description, directory, content_hash, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         description=excluded.description,
         directory=excluded.directory,
         content_hash=excluded.content_hash,
         updated_at=excluded.updated_at`,
      [row.id, row.name, row.description ?? "", row.directory, row.contentHash ?? null, now, now],
    );
  }

  setEnabled(id: string, app: AppType, enabled: boolean): void {
    this.db.run(`UPDATE skills SET enabled_${app} = ?, updated_at = ? WHERE id = ?`, [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM skills WHERE id = ?`, [id]);
  }
}

export class SqliteManifestStore implements ManifestStore {
  constructor(private readonly db: Database) {}

  get(app: AppType, scopeKey: string): Manifest {
    const rows = this.db
      .query(
        `SELECT name, hash FROM config_hub_manifest WHERE app = ? AND scope_key = ?`,
      )
      .all(app, scopeKey) as { name: string; hash: string }[];
    const out: Manifest = {};
    for (const r of rows) out[r.name] = r.hash;
    return out;
  }

  set(app: AppType, scopeKey: string, manifest: Manifest): void {
    const tx = this.db.transaction((m: Manifest) => {
      this.db.run(`DELETE FROM config_hub_manifest WHERE app = ? AND scope_key = ?`, [
        app,
        scopeKey,
      ]);
      const insert = this.db.prepare(
        `INSERT INTO config_hub_manifest (app, scope_key, name, hash) VALUES (?, ?, ?, ?)`,
      );
      for (const [name, hash] of Object.entries(m)) insert.run(app, scopeKey, name, hash);
    });
    tx(manifest);
  }
}
