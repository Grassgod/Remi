/**
 * Config value read/write via ConfigStore (SQLite).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../shared/db/config-store.js";
import { getDb } from "../shared/db/index.js";

const CONFIG_DIR = join(homedir(), ".remi");

/** Ensure ~/.remi/ directory exists. */
export function ensureConfigFile(_templateContent?: string): string {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

/** Get the config directory path. */
export function getConfigPath(): string {
  return CONFIG_DIR;
}

/**
 * Set a value under a config section.
 */
export function setConfigValue(section: string, key: string, value: string): void {
  const store = new ConfigStore(getDb());
  const existing = (store.getSection(section) ?? {}) as Record<string, unknown>;
  existing[key] = value;
  store.setSection(section, existing);
}

/**
 * Set multiple values under a config section at once.
 */
export function setConfigSection(section: string, values: Record<string, string>): void {
  const store = new ConfigStore(getDb());
  const existing = (store.getSection(section) ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    existing[key] = value;
  }
  store.setSection(section, existing);
}

/**
 * Read a single value from config.
 */
export function getConfigValue(section: string, key: string): string | undefined {
  const store = new ConfigStore(getDb());
  const data = store.getSection(section) as Record<string, unknown> | undefined;
  if (data && key in data) return String(data[key]);
  return undefined;
}
