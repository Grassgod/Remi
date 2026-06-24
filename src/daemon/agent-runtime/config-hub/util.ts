/** Filesystem helpers: parse-or-throw JSON read, atomic write, central backup. */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { dirname, basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read a JSON file. Missing/empty → {}. Malformed → THROWS (so a sync aborts
 * and never overwrites a file we failed to parse — protects user data).
 */
export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Write via temp-file + rename so readers never see a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Snapshot a file into a central backup dir before a destructive write. No-op if absent. */
export function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const dir = join(homedir(), ".remi", "config-hub", "backups");
  mkdirSync(dir, { recursive: true });
  const safe = path.replace(/[/\\]/g, "_").replace(/^_+/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, join(dir, `${safe}.${stamp}.bak`));
}

export { basename };
