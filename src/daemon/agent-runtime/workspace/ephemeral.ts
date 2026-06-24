/**
 * Ephemeral workspace resolution + local-directory locking.
 *
 * Resolves a task's working directory, including the "local_directory" project
 * resource path (a fixed on-disk directory the daemon must serialize access to
 * across tasks). `LocalPathLocker` is the FIFO mutex that guarantees only one
 * task at a time runs against a given real path; the daemon holds a single
 * shared instance across all tasks. Extracted verbatim from
 * src/multiremi/worker/daemon.ts in D6 (behavior unchanged).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { AgentTask } from "@daemon/contracts/types.js";
import { resolveWorkDir } from "./persistent.js";

export interface ResolvedTaskWorkDir {
  workDir: string;
  localDirectory: boolean;
  release?: () => void;
}

export class LocalDirectoryError extends Error {
  failureReason = "local_directory_error";
}

interface LocalDirectoryAssignment {
  absPath: string;
  realPath: string;
}

interface LocalPathLockEntry {
  holderId: string | null;
  queue: LocalPathLockWaiter[];
}

interface LocalPathLockWaiter {
  taskId: string;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class LocalPathLocker {
  private entries = new Map<string, LocalPathLockEntry>();

  async acquire(
    realPath: string,
    taskId: string,
    onWait: (holderId: string | null) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (!realPath) throw new LocalDirectoryError("local_directory: realpath required for lock");
    if (!taskId) throw new LocalDirectoryError("local_directory: task id required for lock");
    if (signal.aborted) throw new LocalDirectoryError("local_directory: wait cancelled");
    const entry = this.entries.get(realPath) ?? { holderId: null, queue: [] };
    this.entries.set(realPath, entry);
    if (!entry.holderId) {
      entry.holderId = taskId;
      return this.releaser(realPath, entry, taskId);
    }

    await onWait(entry.holderId);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: LocalPathLockWaiter = {
        taskId,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = entry.queue.indexOf(waiter);
          if (index >= 0) entry.queue.splice(index, 1);
          reject(new LocalDirectoryError("local_directory: wait cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      entry.queue.push(waiter);
    });
  }

  private releaser(realPath: string, entry: LocalPathLockEntry, taskId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (entry.holderId !== taskId) return;
      while (entry.queue.length) {
        const next = entry.queue.shift()!;
        next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted) continue;
        entry.holderId = next.taskId;
        next.resolve(this.releaser(realPath, entry, next.taskId));
        return;
      }
      entry.holderId = null;
    };
  }
}

export interface ResolveTaskWorkDirOptions {
  /** Daemon/runtime identifiers that own local_directory resources. */
  daemonIds: string[];
  /** Root for the default (non-local) per-task workspace path. */
  workspacesRoot: string;
  /** Shared, single-instance locker held across tasks by the daemon. */
  locker: LocalPathLocker;
  signal: AbortSignal;
  /** Invoked while a task waits for a busy local_directory to free up. */
  onWaitLocalDirectory: (taskId: string, reason: string) => Promise<void> | void;
}

export async function resolveTaskWorkDir(
  task: AgentTask,
  opts: ResolveTaskWorkDirOptions,
): Promise<ResolvedTaskWorkDir> {
  const assignment = findLocalDirectoryAssignment(task, opts.daemonIds);
  if (!assignment) {
    return {
      workDir: resolveWorkDir(task, opts.workspacesRoot),
      localDirectory: false,
    };
  }
  validateLocalDirectoryPath(assignment.absPath);
  const release = await opts.locker.acquire(assignment.realPath, task.id, async (holder) => {
    const reason = holder
      ? `local_directory ${assignment.absPath} (held by task ${shortTaskId(holder)})`
      : `local_directory ${assignment.absPath}`;
    await opts.onWaitLocalDirectory(task.id, reason);
  }, opts.signal);
  return {
    workDir: assignment.absPath,
    localDirectory: true,
    release,
  };
}

function findLocalDirectoryAssignment(task: AgentTask, daemonIds: string[]): LocalDirectoryAssignment | null {
  const ids = new Set(daemonIds.map((id) => id.trim()).filter(Boolean));
  if (!ids.size) return null;
  let assignment: LocalDirectoryAssignment | null = null;
  for (const resource of task.projectResources) {
    if (resource.resourceType !== "local_directory") continue;
    const ref = resource.resourceRef ?? {};
    const daemonId = stringField(ref.daemonId ?? ref.daemon_id);
    if (!daemonId) throw new LocalDirectoryError("local_directory: resource_ref missing daemon_id");
    if (!ids.has(daemonId)) continue;
    if (assignment) {
      throw new LocalDirectoryError("local_directory: project has multiple local_directory resources for this daemon");
    }
    const absPath = normalizeLocalDirectoryPath(ref.localPath ?? ref.local_path);
    assignment = { absPath, realPath: resolveLocalRealPath(absPath) };
  }
  return assignment;
}

function normalizeLocalDirectoryPath(value: unknown): string {
  const path = stringField(value);
  if (!path) throw new LocalDirectoryError("local_directory: local_path is empty");
  if (!isAbsoluteLocalPath(path)) throw new LocalDirectoryError(`local_directory: local_path must be absolute, got ${JSON.stringify(path)}`);
  return resolve(path);
}

function validateLocalDirectoryPath(path: string): void {
  if (isBlacklistedLocalDirectory(path)) {
    throw new LocalDirectoryError(`local_directory: path is a protected system root (${JSON.stringify(path)})`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new LocalDirectoryError(`local_directory: path does not exist: ${JSON.stringify(path)}`);
  }
  if (!stats.isDirectory()) throw new LocalDirectoryError(`local_directory: path is not a directory: ${JSON.stringify(path)}`);
  const realPath = resolveLocalRealPath(path);
  if (isBlacklistedLocalDirectory(realPath)) {
    throw new LocalDirectoryError(`local_directory: path resolves to a protected system root (${JSON.stringify(realPath)})`);
  }
  try {
    readdirSync(path);
    const probe = join(path, `.multiremi-rwcheck-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (err) {
    throw new LocalDirectoryError(`local_directory: path is not readable and writable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveLocalRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isAbsoluteLocalPath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function isBlacklistedLocalDirectory(path: string): boolean {
  const normalized = resolve(path);
  if (normalized === homedir()) return true;
  return ["/", "/Users", "/Users/Shared", "/home", "/root", "/var", "/etc", "/tmp", "/usr", "/opt"].includes(normalized);
}

function shortTaskId(taskId: string): string {
  return taskId.length <= 8 ? taskId : taskId.slice(0, 8);
}

function stringField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}
