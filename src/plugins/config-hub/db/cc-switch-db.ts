/**
 * Owns the connection to `~/.cc-switch/cc-switch.db` — the shared global DB,
 * laid out per cc-switch v10 schema for forward compat with the desktop app.
 *
 * Phase 1 creates only `mcp_servers` (matching cc-switch's DDL exactly). Other
 * v10 tables (skills, providers, prompts, etc.) get added by later phases.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MCP_SERVERS_DDL = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_config TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  docs TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  enabled_claude BOOLEAN NOT NULL DEFAULT 0,
  enabled_codex BOOLEAN NOT NULL DEFAULT 0,
  enabled_gemini BOOLEAN NOT NULL DEFAULT 0,
  enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
  enabled_hermes BOOLEAN NOT NULL DEFAULT 0
)`;

const SKILLS_DDL = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  directory TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  repo_branch TEXT DEFAULT 'main',
  readme_url TEXT,
  enabled_claude BOOLEAN NOT NULL DEFAULT 0,
  enabled_codex BOOLEAN NOT NULL DEFAULT 0,
  enabled_gemini BOOLEAN NOT NULL DEFAULT 0,
  enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
  enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

const PROMPTS_DDL = `
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (id, app_type)
)`;

const PROVIDERS_DDL = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  category TEXT,
  created_at INTEGER,
  sort_index INTEGER,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT 0,
  in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
)`;

export function defaultCCSwitchDbPath(home: string = homedir()): string {
  return join(home, ".cc-switch", "cc-switch.db");
}

export function openCCSwitchDb(path: string = defaultCCSwitchDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(MCP_SERVERS_DDL);
  db.run(SKILLS_DDL);
  db.run(PROMPTS_DDL);
  db.run(PROVIDERS_DDL);
  return db;
}

/** SSOT root for installed skills (mirrors cc-switch desktop). */
export function defaultSkillsSsotDir(home: string = homedir()): string {
  return join(home, ".cc-switch", "skills");
}
