/**
 * Tables owned by config-hub but living in Remi's main DB (NOT config-hub.db):
 *  - `config_hub_project_mcp`: per-project MCP overrides (config-hub.db is global-only)
 *  - `config_hub_manifest`:    last-written hash per (tool, scope, server name)
 *
 * Kept separate so config-hub.db holds only global cross-tool config.
 */

import type { Database } from "bun:sqlite";

const PROJECT_MCP_DDL = `
CREATE TABLE IF NOT EXISTS config_hub_project_mcp (
  project_dir   TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  server_config TEXT NOT NULL,
  description   TEXT,
  enabled_claude INTEGER NOT NULL DEFAULT 0,
  enabled_codex  INTEGER NOT NULL DEFAULT 0,
  enabled_gemini INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_dir, id)
)`;

const MANIFEST_DDL = `
CREATE TABLE IF NOT EXISTS config_hub_manifest (
  app       TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  name      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  PRIMARY KEY (app, scope_key, name)
)`;

export function migrateConfigHub(db: Database): void {
  db.run(PROJECT_MCP_DDL);
  db.run(MANIFEST_DDL);
}
