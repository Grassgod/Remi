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
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { selectChatLocalDirectory } from "@multiremi/contracts/chat-local-directory.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { isPathWithinWorkspacesRoot, resolveWorkDir } from "./persistent.js";
import { acquireWorkspaceSupervisorLease, WorkspaceSupervisorOwnedError } from "./process-owner.js";

export interface ResolvedTaskWorkDir {
  runtimeWorkspaceRoot?: string;
  workDir: string;
  localDirectory: boolean;
  // Whether the daemon may create this dir. false only for a local_directory
  // that must already exist; daemon-owned Task/session paths are created.
  ensureDir: boolean;
  release?: () => void;
  /** The inherited provider must not resume after its directory was rejected. */
  resetSession?: true;
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

    return new Promise<() => void>((resolve, reject) => {
      const holderId = entry.holderId;
      let notified = false;
      let settled = false;
      let grantedRelease: (() => void) | null = null;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        const index = entry.queue.indexOf(waiter);
        if (index >= 0) entry.queue.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        // The prior holder may have released while the notification was in
        // flight. Release a promoted waiter too, otherwise the path leaks.
        grantedRelease?.();
        reject(error);
      };
      const finish = () => {
        if (settled || !notified || !grantedRelease) return;
        settled = true;
        signal.removeEventListener("abort", waiter.abort);
        resolve(grantedRelease);
      };
      const waiter: LocalPathLockWaiter = {
        taskId,
        resolve: (release) => {
          if (settled) return release();
          grantedRelease = release;
          finish();
        },
        reject: fail,
        signal,
        abort: () => fail(new LocalDirectoryError("local_directory: wait cancelled")),
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      // Enqueue before any asynchronous wait notification: the holder can
      // release during that notification, and later arrivals must stay FIFO.
      entry.queue.push(waiter);
      Promise.resolve().then(() => {
        if (!settled) return onWait(holderId);
      }).then(() => {
        notified = true;
        finish();
      }, fail);
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
  /** Testable host-local lock registry, outside user-owned directories. */
  runtimeWorkspaceLeaseRoot?: string;
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
  if (task.runtimeWorkspaceId) {
    const workspace = task.runtimeWorkspace;
    if (!workspace || workspace.id !== task.runtimeWorkspaceId || workspace.workspaceId !== task.workspaceId
      || workspace.archivedAt || !opts.daemonIds.includes(workspace.daemonId)) {
      throw new LocalDirectoryError("Runtime workspace is unavailable on this daemon");
    }
    const root = normalizeLocalDirectoryPath(workspace.rootPath);
    validateLocalDirectoryPath(root);
    const workDir = resolve(root, workspace.cwd);
    validateLocalDirectoryPath(workDir);
    const rootReal = realpathSync(root);
    const workReal = realpathSync(workDir);
    const withinRoot = relative(rootReal, workReal);
    if (isAbsolute(withinRoot) || withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
      throw new LocalDirectoryError("Runtime workspace cwd escapes its root");
    }
    const releaseLocal = await opts.locker.acquire(workReal, task.id,
      holder => opts.onWaitLocalDirectory(task.id, `Runtime workspace is busy${holder ? ` (${holder})` : ""}`), opts.signal);
    try {
      while (true) {
        opts.signal.throwIfAborted();
        try {
          const lease = acquireWorkspaceSupervisorLease(workReal, {
            stateRoot: opts.runtimeWorkspaceLeaseRoot ?? join(homedir(), ".multiremi", "runtime-workspace-leases"),
          });
          return {
            workDir, runtimeWorkspaceRoot: rootReal, localDirectory: true, ensureDir: false,
            release: () => { try { lease.release(); } finally { releaseLocal(); } },
          };
        } catch (error) {
          if (!(error instanceof WorkspaceSupervisorOwnedError)) throw error;
          await opts.onWaitLocalDirectory(task.id, `Runtime workspace is busy (process ${error.ownerPid})`);
          await delay(250, undefined, { signal: opts.signal });
        }
      }
    } catch (error) { releaseLocal(); throw error; }
  }
  // Issue workspaces are daemon-owned and stable by Issue key. Historical
  // local_directory resources must never redirect an Issue into a user's
  // checkout; they are retained here only for non-Issue compatibility while
  // archived local_directory projects are removed.
  const assignment = task.issueId ? null : findLocalDirectoryAssignment(task, opts.daemonIds);
  if (task.chatSessionId) {
    // A changed assignment never redirects an existing Chat into another user
    // directory. It either retains its current, locked assignment, or stays in
    // a verified daemon-owned directory. Reject stale paths before any writes.
    const matchesAssignment = Boolean(task.workDir && assignment
      && resolve(task.workDir) === assignment.absPath
      && resolveLocalRealPath(task.workDir) === assignment.realPath);
    if (task.workDir && !matchesAssignment) {
      const owned = await isDaemonOwnedChatPath(task.workDir, opts.workspacesRoot);
      const resolved = resolveWorkDir(owned ? task : { ...task, workDir: null }, opts.workspacesRoot);
      await assertDaemonOwnedChatPath(resolved.workDir, opts.workspacesRoot);
      return { ...resolved, localDirectory: false, ...(!owned ? { resetSession: true as const } : {}) };
    }
    if (!assignment) {
      const resolved = resolveWorkDir(task, opts.workspacesRoot);
      await assertDaemonOwnedChatPath(resolved.workDir, opts.workspacesRoot);
      return { ...resolved, localDirectory: false };
    }
  }
  if (!assignment) {
    const resolved = resolveWorkDir(task, opts.workspacesRoot);
    return {
      workDir: resolved.workDir,
      localDirectory: false,
      ensureDir: resolved.ensureDir,
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
    ensureDir: false,
    release,
  };
}

/** Resolve existing ancestors too, so a not-yet-created child cannot escape via a symlink. */
async function prospectiveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling symlink must not be interpreted as a missing owned directory.
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error("dangling workspace symlink"); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await prospectiveRealPath(parent), basename(path));
  }
}

async function isDaemonOwnedChatPath(path: string, root: string): Promise<boolean> {
  if (!isPathWithinWorkspacesRoot(path, root)) return false;
  try {
    const [realRoot, realPath] = await Promise.all([
      prospectiveRealPath(resolve(root)), prospectiveRealPath(resolve(path)),
    ]);
    if (!isPathWithinWorkspacesRoot(realPath, realRoot)) return false;
    // User local_directory roots may themselves live below workspacesRoot.
    // Their durable marker takes precedence over lexical containment, including
    // when a previously managed path is a symlink into such a user directory.
    for (let current = realPath; ; current = dirname(current)) {
      try {
        const metadataDir = join(current, ".multiremi");
        const marker = join(metadataDir, "gc.json");
        if ((await lstat(metadataDir)).isSymbolicLink() || (await lstat(marker)).isSymbolicLink()) return false;
        const meta = JSON.parse(await readFile(marker, "utf8"));
        if (meta.local_directory) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      if (current === realRoot) break;
    }
    return true;
  } catch {
    return false;
  }
}

async function assertDaemonOwnedChatPath(path: string, root: string): Promise<void> {
  if (!await isDaemonOwnedChatPath(path, root)) {
    throw new LocalDirectoryError("Chat workspace is not daemon-owned; refusing to write to a user directory");
  }
}

function findLocalDirectoryAssignment(task: AgentTask, daemonIds: string[]): LocalDirectoryAssignment | null {
  const ids = new Set(daemonIds.map((id) => id.trim()).filter(Boolean));
  if (!ids.size) return null;
  let localResourceCount = 0;
  for (const resource of task.projectResources) {
    if (resource.resourceType !== "local_directory") continue;
    const ref = resource.resourceRef ?? {};
    const daemonId = stringField(ref.daemonId ?? ref.daemon_id);
    if (!daemonId) throw new LocalDirectoryError("local_directory: resource_ref missing daemon_id");
    if (!ids.has(daemonId)) continue;
    if (++localResourceCount > 1) {
      throw new LocalDirectoryError("local_directory: project has multiple local_directory resources for this daemon");
    }
  }
  // Chat routing selects globally. Non-Chat tasks (e.g. run-only schedules)
  // retain their existing daemon-local eligibility without another selector.
  const resources = task.chatSessionId ? task.projectResources : task.projectResources.filter((resource) =>
    ids.has(stringField(resource.resourceRef?.daemonId ?? resource.resourceRef?.daemon_id) ?? ""));
  const selected = selectChatLocalDirectory(resources);
  if (!selected || !ids.has(selected.daemon)) return null;
  const absPath = normalizeLocalDirectoryPath(selected.path);
  return { absPath, realPath: resolveLocalRealPath(absPath) };
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
