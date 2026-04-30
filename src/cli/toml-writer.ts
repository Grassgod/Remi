/**
 * Safe TOML config file manipulation for remi.toml.
 *
 * Reads/writes specific fields without destroying existing content.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".remi", "remi.toml");

/** Ensure ~/.remi/ exists and remi.toml is present (from template if needed). */
export function ensureConfigFile(templateContent: string): string {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, templateContent, "utf-8");
  }
  return CONFIG_PATH;
}

/** Get the config file path (may not exist). */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Read the raw TOML content. */
export function readConfig(): string {
  if (!existsSync(CONFIG_PATH)) return "";
  return readFileSync(CONFIG_PATH, "utf-8");
}

/**
 * Set a value under a TOML section.
 * Creates the section if it doesn't exist.
 *
 * Example: setConfigValue("feishu", "app_id", "cli_abc123")
 * → [feishu]
 *   app_id = "cli_abc123"
 */
export function setConfigValue(section: string, key: string, value: string): void {
  let raw = readConfig();

  const sectionHeader = `[${section}]`;
  const keyLine = `${key} = "${escapeToml(value)}"`;
  const keyPattern = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=\\s*"[^"]*"`, "m");

  // Find the section
  const sectionIdx = raw.indexOf(sectionHeader);

  if (sectionIdx === -1) {
    // Section doesn't exist — append it
    raw = raw.trimEnd() + `\n\n${sectionHeader}\n${keyLine}\n`;
  } else {
    // Section exists — find the key within it
    const afterSection = raw.slice(sectionIdx + sectionHeader.length);

    // Find the end of this section (next section header or EOF)
    const nextSectionMatch = afterSection.match(/\n\[(?!\[)/);
    const sectionEnd = nextSectionMatch
      ? sectionIdx + sectionHeader.length + (nextSectionMatch.index ?? afterSection.length)
      : raw.length;

    const sectionContent = raw.slice(sectionIdx, sectionEnd);

    if (keyPattern.test(sectionContent)) {
      // Key exists — replace it
      const newSection = sectionContent.replace(keyPattern, keyLine);
      raw = raw.slice(0, sectionIdx) + newSection + raw.slice(sectionEnd);
    } else {
      // Key doesn't exist — append after section header
      const insertPos = sectionIdx + sectionHeader.length;
      raw = raw.slice(0, insertPos) + `\n${keyLine}` + raw.slice(insertPos);
    }
  }

  writeFileSync(CONFIG_PATH, raw, "utf-8");
}

/**
 * Set multiple values under a TOML section at once.
 */
export function setConfigSection(section: string, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    setConfigValue(section, key, value);
  }
}

/**
 * Read a single value from a TOML section.
 * Returns undefined if not found.
 */
export function getConfigValue(section: string, key: string): string | undefined {
  const raw = readConfig();
  const sectionHeader = `[${section}]`;
  const sectionIdx = raw.indexOf(sectionHeader);
  if (sectionIdx === -1) return undefined;

  const afterSection = raw.slice(sectionIdx);
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`, "m");
  const match = afterSection.match(pattern);
  return match?.[1];
}

function escapeToml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
