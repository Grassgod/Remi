/**
 * Restore a reclaimed subject's unsaved work when it reopens (ADR 0018, section 2).
 *
 * Runs after a holder execution has checked out its repositories and
 * materialized the Wiki working copy. Restore never blocks an execution: every
 * failure is logged and the workspace is left as checked out.
 */

import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { StorageSubjectRef, SubjectSnapshot } from "@multiremi/contracts/storage.js";
import { createLogger } from "@shared/logger.js";
import { isLinkedWorktree, restoreSnapshot } from "./git-ops.js";
import { isLaneSnapshotDir, workDirectory } from "./layout.js";
import { readSubjectRecord, updateSubjectRecord } from "./registry.js";
import { restoreWiki } from "./wiki-snapshot.js";

const log = createLogger("multiremi-workspace-restore");

export interface RestoreSubjectOptions {
  root: string;
  subject: StorageSubjectRef;
  /** Also restore the Wiki working copy; false right after a repository checkout alone. */
  wiki: boolean;
  assertRootOwner?: () => void;
}

/**
 * Bring back what the last reclaim saved, for the repositories that are checked
 * out now. An entry is applied only to the worktree that stands at exactly its
 * recorded `dir`, and only when that worktree belongs to the repository that
 * holds the entry's ref and is on the branch the entry was saved on (or is
 * detached at its HEAD); a sibling worktree of the same repository takes
 * nothing. The work directory must be a real directory: a link in its place
 * could lead the saved work into another subject's checkout. Each applied entry
 * is applied once: it leaves the record as soon as it is back, so a later
 * restore (a Chat checks repositories out on demand) can never lay already
 * restored work over a worktree the agent has since cleaned.
 * Entries that were diverged, dirty or missing stay on the record with their
 * ref. Entries whose place holds no worktree yet, or one on another branch, stay
 * too, and are reported; the record turns `active` once none is waiting for a
 * worktree, and until then it stays `reclaimed` so a later checkout can still
 * restore. Entries of a lane (their place is below `env/`) cannot be restored
 * anywhere: the reclaim reported them, they wait for nothing, and the first
 * restore after it takes them off the record.
 */
export async function restoreReclaimedSubject(options: RestoreSubjectOptions): Promise<void> {
  try {
    const record = readSubjectRecord(options.root, options.subject);
    if (!record || record.state !== "reclaimed") return;
    const workDir = workDirectory(options.root, options.subject);
    const info = await lstat(workDir).catch(() => null);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      log.warn(`snapshot_restore_refused: ${options.subject.id}: ${workDir} is not a real directory; the saved work stays at its refs`);
      return;
    }
    const realWorkDir = await realpath(workDir).catch(() => null);
    const waiting: string[] = [];
    const entries = record.snapshot?.git ?? [];
    for (const entry of entries) {
      if (isLaneEntry(options.subject, entry.dir)) continue;
      const worktree = realWorkDir ? await worktreeAt(realWorkDir, entry.dir) : null;
      if (!worktree) {
        waiting.push(`${entry.ref} (${entry.dir})`);
        continue;
      }
      options.assertRootOwner?.();
      try {
        const result = await restoreSnapshot(worktree, entry);
        if (result.status === "other_branch") {
          waiting.push(`${entry.ref} (${entry.dir} is not on ${entry.branch})`);
          continue;
        }
        if (result.status !== "restored") {
          log.warn(`snapshot_restore_${result.status}: ${options.subject.id} ${worktree} left as checked out; snapshot stays at ${entry.ref}`);
          continue;
        }
        log.info(`Restored unsaved work of ${options.subject.id} into ${worktree} from ${entry.ref}`);
        dropRestored(options, (snapshot) => ({ ...snapshot, git: snapshot.git.filter((saved) => saved.ref !== entry.ref) }));
      } catch (error) {
        log.warn(`Could not restore ${entry.ref} into ${worktree}: ${errorMessage(error)}`);
      }
    }
    const lane = entries.filter((entry) => isLaneEntry(options.subject, entry.dir));
    if (lane.length > 0) {
      log.info(`Unsaved work of ${options.subject.id} from lane generations stays at ${lane.map((entry) => entry.ref).join(", ")}; it is not restored`);
      dropRestored(options, (snapshot) => ({ ...snapshot, git: snapshot.git.filter((saved) => !isLaneEntry(options.subject, saved.dir)) }));
    }
    let wikiPending = (record.snapshot?.wiki_files ?? 0) > 0 && !options.wiki;
    if (options.wiki && record.snapshot?.wiki_files) {
      try {
        const pages = restoreWiki({ root: options.root, subject: options.subject, workDir });
        if (pages) log.info(`Restored ${pages} Wiki page(s) of ${options.subject.id}`);
        dropRestored(options, (snapshot) => ({ ...snapshot, wiki_files: 0 }));
      } catch (error) {
        wikiPending = true;
        log.warn(`Could not restore the Wiki of ${options.subject.id}: ${errorMessage(error)}`);
      }
    }
    if (waiting.length > 0) {
      log.warn(`snapshot_restore_pending: ${options.subject.id} still has saved work for ${waiting.join(", ")}`);
    } else if (!wikiPending) {
      options.assertRootOwner?.();
      updateSubjectRecord(options.root, options.subject, (current) => ({ ...current, state: "active" }));
    }
  } catch (error) {
    log.warn(`Restore of ${options.subject.id} failed: ${errorMessage(error)}`);
  }
}

function isLaneEntry(subject: StorageSubjectRef, dir: unknown): boolean {
  return typeof dir === "string" && isLaneSnapshotDir(subject, dir);
}

/**
 * The linked worktree that stands at exactly `dir` below the work directory, or
 * null: nothing there, a place outside the work directory, or a link anywhere
 * along the path (a link could lead to another worktree, even one of the same
 * repository). Both sides are compared as real paths.
 */
async function worktreeAt(realWorkDir: string, dir: unknown): Promise<string | null> {
  if (typeof dir !== "string") return null;
  const expected = resolve(realWorkDir, dir);
  if (expected !== realWorkDir && !expected.startsWith(`${realWorkDir}${sep}`)) return null;
  const actual = await realpath(expected).catch(() => null);
  return actual === expected && await isLinkedWorktree(expected) ? expected : null;
}

/** Write the trimmed snapshot straight away, from the record as it is now. */
function dropRestored(options: RestoreSubjectOptions, trim: (snapshot: SubjectSnapshot) => SubjectSnapshot): void {
  options.assertRootOwner?.();
  updateSubjectRecord(options.root, options.subject, (current) => {
    if (!current.snapshot) return current;
    const snapshot = trim(current.snapshot);
    return { ...current, snapshot: snapshot.git.length || snapshot.wiki_files ? snapshot : null };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
