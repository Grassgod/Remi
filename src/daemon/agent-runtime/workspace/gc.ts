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

import { readFileSync, readdirSync, rmSync, statSync, type Dirent, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
}

export interface RunWorkspaceGcOnceOptions {
  root: string;
  ttlMs: number;
  orphanTtlMs: number;
  client: WorkspaceGcClient;
  now?: number;
}

type MultiremiGcKind = "issue" | "chat" | "autopilot_run" | "quick_create";
type MultiremiGcDecision = "clean" | "orphan" | "skip";

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
  if (!isDirectory(root)) return summary;

  const workspaces = safeReadDir(root) ?? [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.name === ".repos") continue;
    const workspaceDir = join(root, workspace.name);
    const tasks = safeReadDir(workspaceDir) ?? [];
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const taskDir = join(workspaceDir, task.name);
      const decision = await getWorkspaceGcDecision(taskDir, options);
      if (decision === "skip") {
        summary.skipped++;
        continue;
      }
      removeGcWorkDir(root, taskDir);
      if (decision === "orphan") summary.orphaned++;
      else summary.cleaned++;
    }
  }

  return summary;
}

async function getWorkspaceGcDecision(taskDir: string, options: RunWorkspaceGcOnceOptions): Promise<MultiremiGcDecision> {
  const now = options.now ?? Date.now();
  const meta = readGcMeta(taskDir);
  if (!meta) return staleDirDecision(taskDir, options.orphanTtlMs, now);
  if (meta.local_directory) return "skip";

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
): Promise<MultiremiGcDecision> {
  const issueId = stringField(meta.issue_id);
  if (!issueId) return staleDirDecision(taskDir, options.orphanTtlMs, now);
  try {
    const status = await options.client.getIssueGcCheck(issueId);
    if (isTerminalIssueStatus(status.status) && isOlderThan(status.updated_at, options.ttlMs, now)) return "clean";
    return "skip";
  } catch (err) {
    if (isNotFoundError(err)) return staleDirDecision(taskDir, options.orphanTtlMs, now);
    throw err;
  }
}

async function getChatGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcDecision> {
  const sessionId = stringField(meta.chat_session_id);
  if (!sessionId) return staleDirDecision(taskDir, options.orphanTtlMs, now);
  try {
    const status = await options.client.getChatSessionGcCheck(sessionId);
    if (status.status === "archived" && isOlderThan(status.updated_at, options.ttlMs, now)) return "clean";
    return "skip";
  } catch (err) {
    if (isNotFoundError(err)) return "clean";
    throw err;
  }
}

async function getAutopilotRunGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcDecision> {
  const runId = stringField(meta.autopilot_run_id);
  if (!runId) return staleDirDecision(taskDir, options.orphanTtlMs, now);
  try {
    const status = await options.client.getAutopilotRunGcCheck(runId);
    if (isTerminalAutopilotRunStatus(status.status) && isOlderThan(status.completed_at, options.ttlMs, now)) {
      return "clean";
    }
    return "skip";
  } catch (err) {
    if (isNotFoundError(err)) return staleDirDecision(taskDir, options.orphanTtlMs, now);
    throw err;
  }
}

async function getTaskGcDecision(
  meta: MultiremiGcMeta,
  taskDir: string,
  options: RunWorkspaceGcOnceOptions,
  now: number,
): Promise<MultiremiGcDecision> {
  const taskId = stringField(meta.task_id);
  if (!taskId) return staleDirDecision(taskDir, options.orphanTtlMs, now);
  try {
    const status = await options.client.getTaskGcCheck(taskId);
    if (isTerminalTaskStatus(status.status)) return "clean";
    return "skip";
  } catch (err) {
    if (isNotFoundError(err)) return staleDirDecision(taskDir, options.orphanTtlMs, now);
    throw err;
  }
}

function staleDirDecision(taskDir: string, ttlMs: number, now: number): MultiremiGcDecision {
  const stat = safeStat(taskDir);
  if (!stat) return "skip";
  return now - stat.mtimeMs > ttlMs ? "orphan" : "skip";
}

function readGcMeta(taskDir: string): MultiremiGcMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(join(taskDir, ".multiremi", "gc.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as MultiremiGcMeta : null;
  } catch {
    return null;
  }
}

function removeGcWorkDir(root: string, taskDir: string): void {
  const rootPath = resolve(root);
  const dirPath = resolve(taskDir);
  const rel = slashPath(relative(rootPath, dirPath));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`refusing to GC path outside workspace root: ${taskDir}`);
  }
  rmSync(dirPath, { recursive: true, force: true });
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
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

function safeReadDir(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stringField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}
