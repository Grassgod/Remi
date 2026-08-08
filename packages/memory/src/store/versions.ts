/**
 * Versioned file backups under `<root>/.versions/`.
 *
 * Single implementation shared by `MemoryStore` (root = `~/.remi/memory`) and
 * the admin `RemiData` layer (root = `~/.remi/memory` too — both always wrote
 * into the same directory, previously through two divergent copies of this
 * function).
 *
 * What each copy contributed:
 *  - Naming keeps RemiData's extension-aware form (`<stem>-<ts><ext>`). For the
 *    `.md`-only paths MemoryStore backs up it is byte-identical to its old
 *    `basename(path, ".md") + ".md"` form, and it is the only correct one for
 *    the `.mcp.json` / skill files RemiData also backs up.
 *  - Retention stays a per-caller choice, because the two callers do not agree on
 *    what a stem identifies. MemoryStore backs up files whose stem is their
 *    identity (`MEMORY.md`, one `<slug>.md` per entity), so pruning to the newest
 *    `MEMORY_VERSION_RETENTION` per stem+extension prunes one file's own history.
 *    RemiData backs up paths whose stem is *not* unique — every skill's
 *    `SKILL.md` and every scope's `.mcp.json` share one stem — so the same rule
 *    would make backing up one skill delete a different skill's backups. It
 *    therefore keeps its original "never prune" policy by omitting `keep`.
 *  - The two timestamp expressions produced identical strings — `toISOString()`
 *    always emits exactly 3 millisecond digits, so `\.\d{3}Z` and `\.\d+Z` strip
 *    the same suffix, and `.slice(0, 15)` was a no-op on the resulting
 *    15-character `YYYYMMDDTHHMMSS`. The simpler expression survives.
 *  - Content is copied as bytes (RemiData's form) rather than decoded as UTF-8
 *    and re-encoded; identical for text, and lossless for anything else.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** How many backups `MemoryStore` keeps per (stem, extension) pair. */
export const MEMORY_VERSION_RETENTION = 10;

export interface BackupOptions {
  /**
   * Keep only the newest `keep` backups sharing this file's stem and extension.
   * Omit to keep every backup — the right choice when the caller's stems are not
   * unique, since pruning is by stem and cannot tell two sources apart.
   */
  keep?: number;
}

export function backupFile(root: string, filePath: string, options: BackupOptions = {}): void {
  if (!existsSync(filePath)) return;

  const versionsDir = join(root, ".versions");
  if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true });

  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  writeFileSync(join(versionsDir, `${stem}-${ts}${ext}`), readFileSync(filePath));

  if (options.keep === undefined) return;
  const versions = readdirSync(versionsDir)
    .filter((f) => f.startsWith(`${stem}-`) && f.endsWith(ext))
    .sort();
  for (const old of versions.slice(0, -options.keep)) {
    unlinkSync(join(versionsDir, old));
  }
}
