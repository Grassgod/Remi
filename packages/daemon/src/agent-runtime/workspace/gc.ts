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
import { spawnSync } from "node:child_process";
import type { MultiremiIssueWorkspaceArchiveBinding } from "@multiremi/contracts/types.js";
import {
  OWNED_DIRECTORY_QUARANTINE,
  recoverOwnedDirectoryQuarantineSync,
  removeOwnedDirectorySync,
} from "./safe-remove.js";

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
  /** Synchronous process-ownership fence, called immediately before local mutations. */
  assertRootOwner?: () => void;
  onError?: (workspaceDir: string, error: unknown) => void;
  now?: number;
}

type MultiremiGcKind = "issue" | "chat" | "autopilot_run" | "quick_create";
type MultiremiGcDecision = "clean" | "orphan" | "skip";
interface MultiremiGcResolution {
  decision: MultiremiGcDecision;
  archive: MultiremiIssueWorkspaceArchiveBinding | null;
}
const ISSUE_CLEANED_OUTBOX_DIR = ".gc-cleaned-outbox";
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
  options.assertRootOwner?.();
  // A prior process may have crashed after atomically moving an approved
  // deletion out of its live path. Finish that deletion before replaying the
  // cleaned-state outbox so the control plane never reports retained bytes as
  // physically removed.
  recoverOwnedDirectoryQuarantineSync(root, { assertRootOwner: options.assertRootOwner });
  await flushIssueWorkspaceCleanedOutbox(root, options);

  const workspaces = safeReadDir(root) ?? [];
  for (const workspace of workspaces) {
    if (
      !workspace.isDirectory()
      || GC_RESERVED_ROOTS.has(workspace.name)
    ) continue;
    const workspaceDir = join(root, workspace.name);
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

  return summary;
}

async function collectWorkspaceGcDecision(
  root: string,
  workspaceDir: string,
  options: RunWorkspaceGcOnceOptions,
  summary: MultiremiDaemonGcSummary,
): Promise<void> {
  const issueId = stringField(readGcMeta(workspaceDir)?.issue_id);
  if (issueId && options.withIssueWorkspaceLock) {
    await options.withIssueWorkspaceLock(issueId, workspaceDir, async () => {
      if (stringField(readGcMeta(workspaceDir)?.issue_id) !== issueId) {
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

  if (meta.kind === "issue") return getIssueGcDecision(meta, taskDir, options, now);
  if (meta.kind === "chat") return getChatGcDecision(meta, taskDir, options, now);
  if (meta.kind === "autopilot_run") return getAutopilotRunGcDecision(meta, taskDir, options, now);
  return getTaskGcDecision(meta, taskDir, options, now);
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
    if (!isTerminalIssueStatus(status.status)) return gcResolution("skip");
    options.assertRootOwner?.();
    const eligibleForDeletion = isOlderThan(status.updated_at, options.ttlMs, now)
      && !hasDirtyGitWorktree(taskDir);
    if (options.requireIssueSessionArchive) {
      if (!options.ensureIssueSessionArchive) return gcResolution("skip");
      // Archive immediately when the Issue becomes terminal, but never trust
      // that early receipt as the deletion barrier. Provider JSONL can still
      // receive tail events while cancellation drains, so the TTL-expired
      // sweep must compute and verify a fresh snapshot immediately before rm.
      options.assertRootOwner?.();
      const archive = await options.ensureIssueSessionArchive(issueId, taskDir, eligibleForDeletion);
      if (!archive) return gcResolution("skip");
      return eligibleForDeletion ? gcResolution("clean", archive) : gcResolution("skip");
    }
    return eligibleForDeletion ? gcResolution("clean") : gcResolution("skip");
  } catch (err) {
    if (isNotFoundError(err)) {
      if (hasIssueSessionState(taskDir)) {
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

function hasDirtyGitWorktree(workspaceDir: string): boolean {
  for (const entry of safeReadDir(workspaceDir) ?? []) {
    if (!entry.isDirectory() || entry.name === ".multiremi") continue;
    const repoPath = join(workspaceDir, entry.name);
    if (!safeStat(join(repoPath, ".git"))) continue;
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
    if (status.status !== 0 || String(status.stdout ?? "").trim()) return true;
    const contained = spawnSync("git", ["branch", "-r", "--contains", "HEAD"], { cwd: repoPath, encoding: "utf8" });
    if (contained.status !== 0 || !String(contained.stdout ?? "").trim()) return true;
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
