/**
 * Worktrees the legacy sweep could not snapshot (ADR 0018, section 10).
 *
 * Their unsaved work exists only in the files, so the sweep moves them to
 * `legacy-<date>/retained/<original path>` and lists them in `retained.json`.
 * Expiry of `legacy-<date>` never deletes either; the storage report counts
 * the listed worktrees that are still on disk and an operator deletes them by
 * hand once the work is dealt with.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyRetainedList } from "./layout.js";

export type LegacyRetainReason = "snapshot_failed" | "git_check_failed";

export interface RetainedLegacyWorktree {
  /** Below the `legacy-<date>` directory, e.g. `retained/issues/MUL-1/repo`. */
  path: string;
  /** Where the worktree lived below the workspaces root. */
  original_path: string;
  reason: LegacyRetainReason;
  message: string;
}

export interface RetainedLegacyList {
  version: 1;
  worktrees: RetainedLegacyWorktree[];
}

/** Null when the directory has no list. Throws when the list cannot be trusted. */
export function readRetainedList(legacyDir: string): RetainedLegacyList | null {
  const path = legacyRetainedList(legacyDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Retained list is not valid JSON: ${path}`, { cause: error });
  }
  const worktrees = (value as { version?: unknown; worktrees?: unknown } | null)?.worktrees;
  if ((value as { version?: unknown } | null)?.version !== 1 || !Array.isArray(worktrees)
    || !worktrees.every((entry) => typeof entry?.path === "string" && typeof entry?.original_path === "string")) {
    throw new Error(`Retained list has an unsupported shape: ${path}`);
  }
  return { version: 1, worktrees: worktrees as RetainedLegacyWorktree[] };
}

export function writeRetainedList(legacyDir: string, list: RetainedLegacyList): void {
  const path = legacyRetainedList(legacyDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Listed worktrees an operator has not deleted yet. */
export function countRetainedWorktrees(legacyDir: string): number {
  const list = readRetainedList(legacyDir);
  return list ? list.worktrees.filter((entry) => lstatSync(join(legacyDir, entry.path), { throwIfNoEntry: false })).length : 0;
}
