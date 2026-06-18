/**
 * On-disk config for the `remi` daemon binary. Lives at ~/.remi/config.json so
 * a packaged binary needs no DATABASE_URL / repo checkout — only a server URL +
 * token. A stable per-machine daemon_id is generated on first use and persisted
 * so restarts reuse the same runtime rows (the register upsert key).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RemiConfig {
  server_url?: string;
  app_url?: string;
  token?: string;
  workspace_id?: string;
  daemon_id?: string;
}

const DIR = join(homedir(), ".remi");
const FILE = join(DIR, "config.json");

export function configDir(): string {
  return DIR;
}

export function configPath(): string {
  return FILE;
}

export function daemonPidPath(): string {
  return join(DIR, "daemon.pid");
}

export function daemonLogPath(): string {
  return join(DIR, "daemon.log");
}

export function loadConfig(): RemiConfig {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as RemiConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: RemiConfig): void {
  mkdirSync(DIR, { recursive: true });
  // 0600 — the file holds a bearer token.
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Stable per-machine daemon id, generated + persisted on first use. */
export function ensureDaemonId(cfg: RemiConfig): string {
  if (cfg.daemon_id) return cfg.daemon_id;
  cfg.daemon_id = randomUUID();
  saveConfig(cfg);
  return cfg.daemon_id;
}
