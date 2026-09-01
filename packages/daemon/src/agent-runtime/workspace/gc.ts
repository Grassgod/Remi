/**
 * Workspace garbage collection.
 *
 * Sweeps the daemon's workspaces root and removes per-task working directories
 * whose backing entity (issue / chat session / autopilot run / task) is
 * terminal and past TTL, or that are orphaned (no/unknown metadata) past the
 * orphan TTL. Local-directory tasks are never GC'd. The recursive remove is
 * guarded by a containment check so it can never delete outside the root.
 * Extracted verbatim from src/multiremi/worker/daemon.ts in D6 (behavior
 * unchanged).
 */

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MultiremiIssueWorkspaceArchiveBinding } from "@multiremi/contracts/types.js";
import { createLogger } from "@shared/logger.js";
import {
  OWNED_DIRECTORY_QUARANTINE,
  recoverOwnedDirectoryQuarantineSync,
  removeOwnedDirectorySync,
} from "./safe-remove.js";
import { TOPIC_WORKSPACE_ROOT, topicLifecycleKey } from "./topic-lifecycle.js";

const log = createLogger("multiremi-workspace-gc");

export interface MultiremiDaemonGcSummary {
  cleaned: number;
  orphaned: number;
  skipped: number;
}

/** GC-check status returned by the server for a backing entity. */
export interface WorkspaceGcStatus {
  status: string;
  updated_at?: string | null;
  completed_at?: string | null;
}

/** Server surface the GC sweep depends on (one method per backing-entity kind). */
export interface WorkspaceGcClient {
  getIssueGcCheck(issueId: string): Promise<WorkspaceGcStatus>;
  getChatSessionGcCheck(sessionId: string): Promise<WorkspaceGcStatus>;
  getAutopilotRunGcCheck(runId: string): Promise<WorkspaceGcStatus>;
  getTaskGcCheck(taskId: string): Promise<WorkspaceGcStatus>;
  reportIssueWorkspaceCleaned?(
    issueId: string,
    runtimeId: string,
    archive: MultiremiIssueWorkspaceArchiveBinding,
  ): Promise<void>;
}

export interface RunWorkspaceGcOnceOptions {
  root: string;
  ttlMs: number;
  orphanTtlMs: number;
  client: WorkspaceGcClient;
  runtimeId?: string | null;
  requireIssueSessionArchive?: boolean;
  ensureIssueSessionArchive?: (
    issueId: string,
    workspaceDir: string,
    forceFreshSnapshot: boolean,
  ) => Promise<MultiremiIssueWorkspaceArchiveBinding | null>;
  /** Holds the same per-Issue lease used by provider execution through archive + rm. */
  withIssueWorkspaceLock?: (
    issueId: string,
    workspaceDir: string,
    action: () => Promise<void>,
  ) => Promise<void>;
  recoverTopicWorkspace?: (topicDir: string) => Promise<boolean>;
  isTopicWorkspaceBound?: (topicDir: string) => boolean;
  recoverIssueWorkspace?: (issueDir: string) => Promise<boolean>;
  returnTerminalIssueToTopic?: (issueDir: string) => Promise<boolean>;
  /** Synchronous process-ownership fence, called immediately before local mutations. */
  assertRootOwner?: () => void;
  /** Isolated Git inspection; failures must make cleanup fail closed. */
  hasDirtyGitWorktree?: (workspaceDir: string) => Promise<boolean>;
  onError?: (workspaceDir: string, error: unknown) => void;
  now?: number;
}

type MultiremiGcKind = "issue" | "issue_runtime" | "discussion_issue" | "chat" | "autopilot_run" | "quick_create";
type MultiremiGcDecision = "clean" | "orphan" | "skip";
interface MultiremiGcResolution {
  decision: MultiremiGcDecision;
  archive: MultiremiIssueWorkspaceArchiveBinding | null;
}
const ISSUE_CLEANED_OUTBOX_DIR = ".gc-cleaned-outbox";
const DISCUSSION_SESSION_ROOT = "discussions";
const RUNTIME_SESSION_ROOT = ".runtime";
const GC_RESERVED_ROOTS = new Set([
  ISSUE_CLEANED_OUTBOX_DIR,
  ".repos",
  ".runtime-probe",
  ".snapshots",
  OWNED_DIRECTORY_QUARANTINE,
]);

interface MultiremiGcMeta {
  version?: number;
  kind?: MultiremiGcKind;
  workspace_id?: string | null;
  task_id?: string | null;
  issue_id?: string | null;
  issue_session_id?: string | null;
  chat_session_id?: string | null;
  autopilot_run_id?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  local_directory?: boolean;
}

export async function runWorkspaceGcOnce(options: RunWorkspaceGcOnceOptions): Promise<MultiremiDaemonGcSummary> {
  const summary: MultiremiDaemonGcSummary = { cleaned: 0, orphaned: 0, skipped: 0 };
  const root = resolve(options.root);
  if (!isRealDirectory(root)) return summary;
  log.debug(`Workspace GC started: ${root}`);
  options.assertRootOwner?.();
  // A prior process may have crashed after atomically moving an approved
  // deletion out of its live path. Finish that deletion before replaying the
  // cleaned-state outbox so the control plane never reports retained bytes as
  // physically removed.
  recoverOwnedDirectoryQuarantineSync(root, { assertRootOwner: options.assertRootOwner });
  log.debug(`Workspace GC quarantine recovery finished: ${root}`);
  await flushIssueWorkspaceCleanedOutbox(root, options);
  log.debug(`Workspace GC outbox flush finished: ${root}`);

  const workspaces = safeReadDir(root) ?? [];
  for (const workspace of workspaces) {
    if (
      !workspace.isDirectory()
      || GC_RESERVED_ROOTS.has(workspace.name)
    ) continue;
    const workspaceDir = join(root, workspace.name);
    if (workspace.name === RUNTIME_SESSION_ROOT) {
      for (const session of safeReadDir(workspaceDir) ?? []) {
        if (!session.isDirectory()) continue;
        const sessionDir = join(workspaceDir, session.name);
        // Issue history is archived and removed together with its business
        // workspace under the Issue lifecycle lock. Never collect one lineage
        // independently and accidentally make the aggregate incomplete.
        if (readGcMeta(sessionDir)?.kind === "issue_runtime") continue;
        await collectWorkspaceGcDecision(root, sessionDir, options, summary);
      }
      continue;
    }
    if (workspace.name === TOPIC_WORKSPACE_ROOT) {
      for (const topic of safeReadDir(workspaceDir) ?? []) {
        if (!topic.isDirectory()) continue;
        await collectTopicWorkspace(
          root,
          join(workspaceDir, topic.name),
          topic.name,
          options,
          summary,
        );
      }
      continue;
    }
    if (workspace.name === DISCUSSION_SESSION_ROOT) {
      const issues = safeReadDir(workspaceDir) ?? [];
      for (const issue of issues) {
        if (!issue.isDirectory()) continue;
        const sessions = safeReadDir(join(workspaceDir, issue.name)) ?? [];
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          await collectWorkspaceGcDecision(
            root,
            join(workspaceDir, issue.name, session.name),
            options,
            summary,
          );
        }
      }
      continue;
    }
    log.debug(`Workspace GC evaluating: ${workspaceDir}`);
    // A corrupt/missing gc.json must not make a v2 Issue workspace look like
    // the legacy <workspace>/<task> layout. Keep the workspace as one GC unit
    // whenever daemon control state or provider Session state is present.
    if (
      readGcMeta(workspaceDir)
      || hasGcMetadataNode(workspaceDir)
      || hasIssueSessionRoot(workspaceDir)
    ) {
      await collectWorkspaceGcDecision(root, workspaceDir, options, summary);
      continue;
    }
    // Legacy layout: <root>/<workspace-id>/<task-id>. New Issue workspaces
    // place gc.json directly at <root>/<issue-key> and are handled above.
    const tasks = safeReadDir(workspaceDir) ?? [];
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const taskDir = join(workspaceDir, task.name);
      await collectWorkspaceGcDecision(root, taskDir, options, summary);
    }
  }

  log.debug(`Workspace GC finished: ${root}`, summary);
  return summary;
}

async function collectTopicWorkspace(
  root: string,
  topicDir: string,
  topicId: string,
  options: RunWorkspaceGcOnceOptions,
  summary: MultiremiDaemonGcSummary,
): Promise<void> {
  try {
    if (await options.recoverTopicWorkspace?.(topicDir)) {
      summary.skipped++;
      return;
    }
    if (!safeLstat(topicDir)) {
      summary.skipped++;
      return;
    }
    const action = async () => {
      if (options.isTopicWorkspaceBound?.(topicDir)) {
        summary.skipped++;
        return;
      }
      const decision = staleDirDecision(topicDir, options.orphanTtlMs, options.now ?? Date.now());
      if (decision !== "orphan") {
        summary.skipped++;
        return;
      }
      options.assertRootOwner?.();
      removeGcWorkDir(root, topicDir, options.assertRootOwner);
      summary.orphaned++;
    };
    if (options.withIssueWorkspaceLock) {
      await options.withIssueWorkspaceLock(topicLifecycleKey(topicId), topicDir, action);
    } else {
      await action();
    }
  } catch (error) {
    summary.skipped++;
    options.onError?.(topicDir, error);
  }
}

async function collectWorkspaceGcDecision(
  root: string,
  workspaceDir: string,
  options: RunWorkspaceGcOnceOptions,
  summary: MultiremiDaemonGcSummary,
): Promise<void> {
  const meta = readGcMeta(workspaceDir);
  const issueId = stringField(meta?.issue_id);
  const issueSessionId = stringField(meta?.issue_session_id);
  const lifecycleKey = meta?.kind === "discussion_issue" && issueSessionId
    ? discussionSessionLifecycleKey(issueSessionId)
    : issueId;
  if (lifecycleKey && options.withIssueWorkspaceLock) {
    await options.withIssueWorkspaceLock(lifecycleKey, workspaceDir, async () => {
      const lockedMeta = readGcMeta(workspaceDir);
      const lockedLifecycleKey = lockedMeta?.kind === "discussion_issue"
        ? stringField(lockedMeta.issue_session_id)
        : stringField(lockedMeta?.issue_id);
      const expectedLockedKey = lockedMeta?.kind === "discussion_issue" && lockedLifecycleKey
        ? discussionSessionLifecycleKey(lockedLifecycleKey)
        : lockedLifecycleKey;
      if (expectedLockedKey !== lifecycleKey) {
        throw new Error(`Issue workspace ownership changed while waiting for lifecycle lock: ${workspaceDir}`);
      }
      await collectWorkspaceGcDecisionUnlocked(root, workspaceDir, options, summary);
    });
    return;
  }
  await collectWorkspaceGcDecisionUnlocked(root, workspaceDir, options, summary);
}

async function collectWorkspaceGcDecisionUnlocked(
  root: string,
  workspaceDir: string,
  options: RunWorkspaceGcOnceOptions,
  summary: MultiremiDaemonGcSummary,
): Promise<void> {
  let resolution: MultiremiGcResolution;
  try {
    await options.recoverIssueWorkspace?.(workspaceDir);
    resolution = await getWorkspaceGcDecision(workspaceDir, options);
  } catch (error) {
    // One unavailable entity or archive upload must not prevent later
    // workspaces from being evaluated. Failure remains fail-closed for this
    // workspace and is surfaced through the daemon logger.
    summary.skipped++;
    options.onError?.(workspaceDir, error);
    return;
  }
  const { decision } = resolution;
  if (decision === "skip") {
    summary.skipped++;
    return;
  }
  const issueId = stringField(readGcMeta(workspaceDir)?.issue_id);
  let reportReceipt: string | null = null;
  if (
    decision === "clean"
    && issueId
    && options.runtimeId
    && resolution.archive
    && options.client.reportIssueWorkspaceCleaned
  ) {
    options.assertRootOwner?.();
    reportReceipt = persistIssueWorkspaceCleanedReceipt(
      root,
      issueId,
      options.runtimeId,
      workspaceDir,
      resolution.archive,
    );
  }
  try {
    options.assertRootOwner?.();
    if (decision === "clean" && issueId) {
      // `getIssueGcDecision` has already crossed the archive barrier (when
      // enabled). Remove provider-native history before the Issue workspace;
      // its durable archive receipt remains inside the workspace, so a crash
      // after a partial runtime cleanup retries against the same verified
      // archive rather than producing a snapshot of only the survivors.
      removeIssueRuntimeRoots(root, issueId, options.assertRootOwner);
    }
    removeGcWorkDir(root, workspaceDir, options.assertRootOwner);
  } catch (error) {
    if (reportReceipt) {
      try {
        options.assertRootOwner?.();
        rmSync(reportReceipt, { force: true });
      } catch {
        // A receipt is harmless while the workspace remains. Ownership loss
        // must never redirect cleanup into a replacement root.
      }
    }
    throw error;
  }
  if (reportReceipt && issueId && options.runtimeId && resolution.archive) {
    try {
      await options.client.reportIssueWorkspaceCleaned!(
        issueId,
        options.runtimeId,
        resolution.archive,
      );
      options.assertRootOwner?.();
      rmSync(reportReceipt, { force: true });
    } catch (error) {
      options.onError?.(reportReceipt, error);
    }
  }
  if (decision === "orphan") summary.orphaned++;
  else summary.cleaned++;
}

interface IssueWorkspaceCleanedReceipt {
  version: 2;
  issue_id: string;
  runtime_id: string;
  workspace_dir: string;
  archive_id: string;
  source_revision: string;
  sha256: string;
}

function persistIssueWorkspaceCleanedReceipt(
  root: string,
  issueId: string,
  runtimeId: string,
  workspaceDir: string,
  archive: MultiremiIssueWorkspaceArchiveBinding,
): string {
  const outbox = ensureIssueWorkspaceCleanedOutbox(root);
  const name = `${Buffer.from(`${issueId}\0${runtimeId}`, "utf8").toString("base64url")}.json`;
  const target = join(outbox, name);
  const temporary = `${target}.${process.pid}.${randomUUID()}.partial`;
  const receipt: IssueWorkspaceCleanedReceipt = {
    version: 2,
    issue_id: issueId,
    runtime_id: runtimeId,
    workspace_dir: resolve(workspaceDir),
    archive_id: archive.archiveId,
    source_revision: archive.sourceRevision,
    sha256: archive.sha256,
  };
  const receiptFd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(receiptFd, `${JSON.stringify(receipt)}\n`);
    fsyncSync(receiptFd);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    closeSync(receiptFd);
  }
  renameSync(temporary, target);
  const outboxFd = openSync(outbox, "r");
  try {
    fsyncSync(outboxFd);
  } finally {
    closeSync(outboxFd);
  }
  return target;
}

async function flushIssueWorkspaceCleanedOutbox(
  root: string,
  options: RunWorkspaceGcOnceOptions,
): Promise<void> {
  if (!options.client.reportIssueWorkspaceCleaned) return;
  const outbox = join(root, ISSUE_CLEANED_OUTBOX_DIR);
  const info = safeLstat(outbox);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    options.onError?.(outbox, new Error(`Issue workspace cleanup outbox is unsafe: ${outbox}`));
    return;
  }
  for (const entry of safeReadDir(outbox) ?? []) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(outbox, entry.name);
    try {
      const receipt = parseIssueWorkspaceCleanedReceipt(path);
      assertReceiptWorkspaceContained(root, receipt.workspace_dir);
      // A crash before the workspace rm leaves a harmless stale receipt. Do
      // not tell the server that a directory which still exists was cleaned.
      if (safeLstat(receipt.workspace_dir)) {
        options.assertRootOwner?.();
        rmSync(path, { force: true });
        continue;
      }
      try {
        await options.client.reportIssueWorkspaceCleaned(
          receipt.issue_id,
          receipt.runtime_id,
          {
            archiveId: receipt.archive_id,
            sourceRevision: receipt.source_revision,
            sha256: receipt.sha256,
          },
        );
      } catch (error) {
        // The Issue may be hard-deleted after the cleaned state committed but
        // before a duplicate outbox delivery. A 404 is terminal acknowledgement.
        if (!isIssueNotFoundError(error)) throw error;
      }
      options.assertRootOwner?.();
      rmSync(path, { force: true });
    } catch (error) {
      options.onError?.(path, error);
    }
  }
}

function ensureIssueWorkspaceCleanedOutbox(root: string): string {
  const path = join(root, ISSUE_CLEANED_OUTBOX_DIR);
  const current = safeLstat(path);
  if (!current) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Issue workspace cleanup outbox is unsafe: ${path}`);
  }
  return path;
}

function parseIssueWorkspaceCleanedReceipt(path: string): IssueWorkspaceCleanedReceipt {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IssueWorkspaceCleanedReceipt>;
  if (
    parsed.version !== 2
    || !stringField(parsed.issue_id)
    || !stringField(parsed.runtime_id)
    || !stringField(parsed.workspace_dir)
    || !stringField(parsed.archive_id)
    || !stringField(parsed.source_revision)
    || !sha256Field(parsed.sha256)
  ) throw new Error(`Invalid Issue workspace cleanup receipt: ${path}`);
  return parsed as IssueWorkspaceCleanedReceipt;
}

function assertReceiptWorkspaceContained(root: string, workspaceDir: string): void {
  const rootPath = resolve(root);
  const workspacePath = resolve(workspaceDir);
  const rel = slashPath(relative(rootPath, workspacePath));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Issue workspace cleanup receipt escapes workspace root: ${workspaceDir}`);
  }
}

async function getWorkspaceGcDecision(
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
): Promise<MultiremiGcResolution> {
  const now = options.now ?? Date.now();
  const meta = readGcMeta(taskDir);
  if (!meta) {
    if (hasIssueSessionState(taskDir)) {
      throw new Error(
        `Workspace ${taskDir} has provider Session state but no valid GC metadata; refusing orphan cleanup`,
      );
    }
    return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  }
  if (meta.local_directory) return gcResolution("skip");
  if (meta.kind === "issue_runtime") return gcResolution("skip");

  if (meta.kind === "issue") return getIssueGcDecision(meta, taskDir, options, now);
  if (meta.kind === "discussion_issue") return getDiscussionIssueGcDecision(meta, taskDir, options, now);
  if (meta.kind === "chat") return getChatGcDecision(meta, taskDir, options, now);
  if (meta.kind === "autopilot_run") return getAutopilotRunGcDecision(meta, taskDir, options, now);
  return getTaskGcDecision(meta, taskDir, options, now);
}

async function getDiscussionIssueGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcResolution> {
  const issueId = stringField(meta.issue_id);
  const issueSessionId = stringField(meta.issue_session_id);
  if (!issueId || !issueSessionId) {
    return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  }
  try {
    const status = await options.client.getIssueGcCheck(issueId);
    if (isTerminalIssueStatus(status.status) && isOlderThan(status.updated_at, options.ttlMs, now)) {
      return gcResolution("clean");
    }
    return gcResolution("skip");
  } catch (error) {
    if (isNotFoundError(error)) {
      return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
    }
    throw error;
  }
}

export function discussionSessionLifecycleKey(issueSessionId: string): string {
  const sessionId = issueSessionId.trim();
  if (!sessionId) throw new Error("Discussion Session lifecycle lock requires a Session id");
  return `discussion-session:${sessionId}`;
}

async function getIssueGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcResolution> {
  const issueId = stringField(meta.issue_id);
  if (!issueId) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  try {
    const status = await options.client.getIssueGcCheck(issueId);
    log.debug(`Workspace GC Issue status: ${taskDir} status=${status.status}`);
    if (!isTerminalIssueStatus(status.status)) return gcResolution("skip");
    if (await options.returnTerminalIssueToTopic?.(taskDir)) return gcResolution("skip");
    options.assertRootOwner?.();
    log.debug(`Workspace GC inspecting Git state: ${taskDir}`);
    const dirty = options.hasDirtyGitWorktree
      ? await options.hasDirtyGitWorktree(taskDir)
      : hasPotentialGitWorktree(taskDir);
    log.debug(`Workspace GC Git state inspected: ${taskDir} dirty=${dirty}`);
    const eligibleForDeletion = isOlderThan(status.updated_at, options.ttlMs, now) && !dirty;
    if (options.requireIssueSessionArchive) {
      if (!options.ensureIssueSessionArchive) return gcResolution("skip");
      // Archive immediately when the Issue becomes terminal, but never trust
      // that early receipt as the deletion barrier. Provider JSONL can still
      // receive tail events while cancellation drains, so the TTL-expired
      // sweep must compute and verify a fresh snapshot immediately before rm.
      options.assertRootOwner?.();
      log.debug(`Workspace GC preparing Session archive: ${taskDir} fresh=${eligibleForDeletion}`);
      const archive = await options.ensureIssueSessionArchive(issueId, taskDir, eligibleForDeletion);
      log.debug(`Workspace GC Session archive prepared: ${taskDir} available=${Boolean(archive)}`);
      if (!archive) return gcResolution("skip");
      return eligibleForDeletion ? gcResolution("clean", archive) : gcResolution("skip");
    }
    return eligibleForDeletion ? gcResolution("clean") : gcResolution("skip");
  } catch (err) {
    if (isNotFoundError(err)) {
      if (hasIssueSessionState(taskDir) || hasIssueRuntimeState(options.root, issueId)) {
        throw new Error(
          `Issue ${issueId} is missing from the server while provider Session state remains; refusing orphan cleanup`,
          { cause: err },
        );
      }
      return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
    }
    throw err;
  }
}

/**
 * A missing server row cannot prove that provider-native history was archived.
 * Treat unreadable or non-regular Session state as present so cleanup fails
 * closed instead of traversing a symlink or deleting unverified bytes.
 */
function hasIssueSessionState(workspaceDir: string): boolean {
  const sessionsRoot = join(workspaceDir, ".multiremi", "sessions");
  let rootInfo: Stats;
  try {
    rootInfo = lstatSync(sessionsRoot);
  } catch (error) {
    return !isFsNotFoundError(error);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return true;

  const pending = [sessionsRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = safeReadDir(directory);
    if (entries === null) return true;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = safeLstat(path);
      if (!info) return true;
      if (info.isSymbolicLink()) return true;
      if (info.isDirectory()) {
        pending.push(path);
        continue;
      }
      return true;
    }
  }
  return false;
}

function hasIssueRuntimeState(root: string, issueId: string): boolean {
  return issueRuntimeRoots(root, issueId).length > 0;
}

function removeIssueRuntimeRoots(root: string, issueId: string, assertRootOwner?: () => void): void {
  for (const sessionRoot of issueRuntimeRoots(root, issueId)) {
    assertRootOwner?.();
    removeGcWorkDir(root, sessionRoot, assertRootOwner);
  }
}

function issueRuntimeRoots(root: string, issueId: string): string[] {
  const runtimeRoot = join(resolve(root), RUNTIME_SESSION_ROOT);
  const info = safeLstat(runtimeRoot);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Runtime state root must be a real directory: ${runtimeRoot}`);
  }
  const roots: string[] = [];
  for (const entry of safeReadDir(runtimeRoot) ?? []) {
    if (!entry.isDirectory()) continue;
    const sessionRoot = join(runtimeRoot, entry.name);
    const meta = readGcMeta(sessionRoot);
    if (meta?.kind === "issue_runtime" && stringField(meta.issue_id) === issueId) {
      roots.push(sessionRoot);
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

function hasPotentialGitWorktree(workspaceDir: string): boolean {
  const entries = safeReadDir(workspaceDir);
  if (!entries) return true;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".multiremi") continue;
    const repoPath = join(workspaceDir, entry.name);
    // The production daemon injects the pure-JavaScript inspector. Direct
    // callers without one must retain Git workspaces instead of spawning a
    // native process from this shared GC module.
    try {
      lstatSync(join(repoPath, ".git"));
      return true;
    } catch (error) {
      if (!isFsNotFoundError(error)) return true;
    }
  }
  return false;
}

async function getChatGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcResolution> {
  const sessionId = stringField(meta.chat_session_id);
  if (!sessionId) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  try {
    const status = await options.client.getChatSessionGcCheck(sessionId);
    if (status.status === "archived" && isOlderThan(status.updated_at, options.ttlMs, now)) return gcResolution("clean");
    return gcResolution("skip");
  } catch (err) {
    if (isNotFoundError(err)) return gcResolution("clean");
    throw err;
  }
}

async function getAutopilotRunGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcResolution> {
  const runId = stringField(meta.autopilot_run_id);
  if (!runId) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  try {
    const status = await options.client.getAutopilotRunGcCheck(runId);
    if (isTerminalAutopilotRunStatus(status.status) && isOlderThan(status.completed_at, options.ttlMs, now)) {
      return gcResolution("clean");
    }
    return gcResolution("skip");
  } catch (err) {
    if (isNotFoundError(err)) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
    throw err;
  }
}

async function getTaskGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcResolution> {
  const taskId = stringField(meta.task_id);
  if (!taskId) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
  try {
    const status = await options.client.getTaskGcCheck(taskId);
    if (isTerminalTaskStatus(status.status)) return gcResolution("clean");
    return gcResolution("skip");
  } catch (err) {
    if (isNotFoundError(err)) return gcResolution(staleDirDecision(taskDir, options.orphanTtlMs, now));
    throw err;
  }
}

function staleDirDecision(taskDir: string, ttlMs: number, now: number): MultiremiGcDecision {
  const stat = safeStat(taskDir);
  if (!stat) return "skip";
  return now - stat.mtimeMs > ttlMs ? "orphan" : "skip";
}

function gcResolution(
  decision: MultiremiGcDecision,
  archive: MultiremiIssueWorkspaceArchiveBinding | null = null,
): MultiremiGcResolution {
  return { decision, archive };
}

function readGcMeta(taskDir: string): MultiremiGcMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(join(taskDir, ".multiremi", "gc.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as MultiremiGcMeta : null;
  } catch {
    return null;
  }
}

function hasGcMetadataNode(workspaceDir: string): boolean {
  return safeLstat(join(workspaceDir, ".multiremi", "gc.json")) !== null;
}

function hasIssueSessionRoot(workspaceDir: string): boolean {
  return safeLstat(join(workspaceDir, ".multiremi", "sessions")) !== null;
}

function removeGcWorkDir(root: string, taskDir: string, assertRootOwner?: () => void): void {
  const rootPath = resolve(root);
  const dirPath = resolve(taskDir);
  const rel = slashPath(relative(rootPath, dirPath));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`refusing to GC path outside workspace root: ${taskDir}`);
  }
  removeOwnedDirectorySync(rootPath, dirPath, { assertRootOwner });
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isOlderThan(value: string | null | undefined, ttlMs: number, now: number): boolean {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && now - time > ttlMs;
}

function isTerminalIssueStatus(status: string): boolean {
  return ["done", "completed", "closed", "cancelled"].includes(status);
}

function isTerminalAutopilotRunStatus(status: string): boolean {
  return ["issue_created", "completed", "failed", "skipped"].includes(status);
}

function isTerminalTaskStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

function isIssueNotFoundError(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && err.code === "issue_not_found";
}

function isFsNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function safeReadDir(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function stringField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function sha256Field(value: unknown): string | null {
  const trimmed = stringField(value)?.toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}
