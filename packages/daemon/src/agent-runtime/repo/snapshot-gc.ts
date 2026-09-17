import { lstatSync, mkdirSync, readdirSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OWNED_DIRECTORY_QUARANTINE,
  removeOwnedDirectorySync,
} from "../workspace/safe-remove.js";

export interface SnapshotGcSummary {
  /** Snapshot trees (including abandoned temporary trees), excluding empty containers. */
  removed: number;
  retained: number;
  /** Entries or containers that could not safely be examined or removed. */
  skipped: number;
}

export interface RunSnapshotGcOnceOptions {
  workspacesRoot: string;
  snapshotsRoot: string;
  repoCacheRoot: string;
  ttlMs: number;
  now?: number;
  withRepoLock: (barePath: string, fn: () => void) => Promise<void>;
  assertRootOwner?: () => void;
  onError?: (path: string, error: unknown) => void;
}

/** Sweep independently of workspace GC, which reserves the .snapshots tree. */
export async function runSnapshotGcOnce(options: RunSnapshotGcOnceOptions): Promise<SnapshotGcSummary> {
  const root = resolve(options.workspacesRoot);
  const snapshotsRoot = resolve(options.snapshotsRoot);
  const rel = relative(root, snapshotsRoot);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || rel.split(sep).includes(OWNED_DIRECTORY_QUARANTINE)) {
    throw new Error(`snapshot root must be inside the workspace root: ${snapshotsRoot}`);
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
    throw new Error("snapshot TTL must be a finite non-negative number");
  }
  const now = options.now ?? Date.now();
  const summary: SnapshotGcSummary = { removed: 0, retained: 0, skipped: 0 };
  const expired = (info: Stats) => now - info.mtimeMs > options.ttlMs;
  const failed = (path: string, error: unknown) => {
    summary.skipped++;
    options.onError?.(path, error);
  };
  // Check every ancestor with lstat: checking only the leaf would still follow
  // a workspace/repository directory replaced by a link while awaiting a lock.
  const realDirectory = (path: string): Stats | null => {
    let current = root;
    let info = lstatSync(current, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      info = lstatSync(current, { throwIfNoEntry: false });
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    }
    return info;
  };
  const directories = (parent: string): string[] => {
    const result: string[] = [];
    try {
      if (!realDirectory(parent)) return result;
      for (const name of readdirSync(parent)) {
        const path = join(parent, name);
        try {
          if (name === OWNED_DIRECTORY_QUARANTINE || !realDirectory(path)) {
            summary.skipped++;
            continue;
          }
          result.push(path);
        } catch (error) {
          failed(path, error);
        }
      }
    } catch (error) {
      failed(parent, error);
    }
    return result;
  };
  const removeEmpty = (path: string, requireExpired: boolean) => {
    const info = realDirectory(path);
    if (info && (!requireExpired || expired(info)) && readdirSync(path).length === 0) {
      removeOwnedDirectorySync(root, path, { assertRootOwner: options.assertRootOwner });
    }
  };

  try {
    if (!realDirectory(snapshotsRoot)) return summary;
    options.assertRootOwner?.();
  } catch (error) {
    failed(snapshotsRoot, error);
    return summary;
  }
  for (const workspaceDir of directories(snapshotsRoot)) {
    for (const repoDir of directories(workspaceDir)) {
      const entries = directories(repoDir);
      const barePath = join(options.repoCacheRoot, relative(snapshotsRoot, repoDir));
      try {
        mkdirSync(dirname(barePath), { recursive: true });
        await options.withRepoLock(barePath, () => {
          if (!realDirectory(repoDir)) {
            summary.skipped++;
            return;
          }
          for (const path of entries) {
            try {
              // Access can refresh mtime while this sweep is waiting for the
              // same lock used by createSnapshot. Always decide under the lock.
              const info = realDirectory(path);
              if (!info) {
                summary.skipped++;
              } else if (!expired(info)) {
                summary.retained++;
              } else if (removeOwnedDirectorySync(root, path, { assertRootOwner: options.assertRootOwner })) {
                summary.removed++;
              } else {
                summary.skipped++;
              }
            } catch (error) {
              failed(path, error);
            }
          }
          removeEmpty(repoDir, false);
        });
      } catch (error) {
        // A busy repository (including lock acquisition timeout) never aborts
        // the sweep of unrelated repositories.
        failed(repoDir, error);
      }
    }
    try {
      removeEmpty(workspaceDir, true);
    } catch (error) {
      failed(workspaceDir, error);
    }
  }
  return summary;
}
