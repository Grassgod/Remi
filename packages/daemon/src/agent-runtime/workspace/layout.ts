/**
 * Daemon workspace layout (ADR 0017).
 *
 * Every path below the workspaces root is computed here; no other module joins
 * root-relative segments on its own.
 *
 * ```text
 * registry/<subject>.json           subject record (see registry.ts)
 * registry/<subject>.snapshot/      wiki snapshot of a reclaimed subject
 * work/<subject>/                   workspace: repositories, wiki/, .multiremi/wiki-base/
 * env/<subject>/<conversation>/<agent>/<scope>/<generation>/   one lane generation
 *                                   (work/ below it is an Issue holder's cwd or a discussion's work set)
 * env/<subject>/tmp/<task>-XXXXXX/  execution-private temp directory
 * traces/<subject>/<task>.jsonl     trace records
 * shared/repos/  shared/code-views/ rebuildable shared caches
 * .daemon/                          probe, deletion quarantine, pending reports, disk-usage.json
 * _topics/<topic>/                  Feishu topic workspaces
 * legacy-<date>/                    pre-ADR-0017 layout moved aside by the sweep;
 *                                   retained/ + retained.json: worktrees whose unsaved work was not snapshotted
 * ```
 */

import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import type { AgentTask } from "@daemon/contracts/types.js";

export const REGISTRY_DIRECTORY = "registry";
export const WORK_DIRECTORY = "work";
export const ENV_DIRECTORY = "env";
export const TRACES_DIRECTORY = "traces";
export const SHARED_DIRECTORY = "shared";
export const DAEMON_DIRECTORY = ".daemon";
/** Deletion quarantine below the daemon state directory. */
export const QUARANTINE_DIRECTORY = "quarantine";
export const TOPICS_DIRECTORY = "_topics";
export const LEGACY_DIRECTORY_PREFIX = "legacy-";
/** Below a `legacy-<date>` directory: worktrees whose unsaved work could not be snapshotted. Expiry never deletes it. */
export const LEGACY_RETAINED_DIRECTORY = "retained";
/** Beside `retained/`: which worktree went where, and why. */
export const LEGACY_RETAINED_LIST = "retained.json";
/** Execution-private temp directories of one subject; never a conversation id. */
export const TASK_TMP_DIRECTORY = "tmp";
/** Scope directory of an execution that is not a delegation. */
export const MAIN_SCOPE = "main";

const LAYOUT_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  REGISTRY_DIRECTORY,
  WORK_DIRECTORY,
  ENV_DIRECTORY,
  TRACES_DIRECTORY,
  SHARED_DIRECTORY,
  DAEMON_DIRECTORY,
  TOPICS_DIRECTORY,
]);

/** Root entries owned by the current layout; anything else is a leftover of an older one. */
export function isLayoutRootEntry(name: string): boolean {
  return LAYOUT_ROOT_ENTRIES.has(name) || name.startsWith(LEGACY_DIRECTORY_PREFIX);
}

export interface LaneIdentity {
  subject: StorageSubjectRef;
  /** Issue session id, Chat id, or task id: the conversation that owns the lane. */
  conversation: string;
  agentId: string;
  /** Delegation id; empty for the main execution scope. */
  scope: string | null | undefined;
  generation: number;
}

/**
 * The subject that owns a task's workspace and records: Chat, then Issue, then
 * the task itself. A task that carries both a Chat and an Issue (a relayed
 * Feishu topic, a Chat bound to a Project) belongs to the Chat, matching how its
 * workspace has always been chosen; only an execution with neither falls back to
 * its own task id.
 */
export function subjectForTask(task: AgentTask): StorageSubjectRef {
  const chatId = cleanString(task.chatSessionId);
  if (chatId) return { kind: "chat", id: chatId };
  const issueId = cleanString(task.issueId ?? task.issue_id);
  if (issueId) return { kind: "issue", id: issueId };
  return { kind: "task", id: task.id };
}

/** The conversation whose provider history a task appends to. */
export function conversationForTask(task: AgentTask, subject = subjectForTask(task)): string {
  if (subject.kind === "chat" || subject.kind === "task") return subject.id;
  return cleanString(task.issueSessionId ?? task.issue_session_id) ?? subject.id;
}

/** Lane of a task, or null when it has no agent to give the lane a name. */
export function laneForTask(task: AgentTask): LaneIdentity | null {
  const agentId = cleanString(task.agent?.id);
  if (!agentId) return null;
  const subject = subjectForTask(task);
  return {
    subject,
    conversation: conversationForTask(task, subject),
    agentId,
    scope: task.execution_scope,
    generation: positiveInteger(task.issueSessionGeneration ?? task.issue_session_generation, 1),
  };
}

/** A holder owns the subject's workspace; discussion sessions work on a private set. */
export function holdsWorkspace(task: AgentTask): boolean {
  return task.holdsWorkspace !== false && task.holds_workspace !== false;
}

/**
 * Whether the task works in its subject's `work/<subject>` directory. Only an
 * Issue has non-holder discussion sessions; a Chat bound to an Issue topic is
 * flagged as a non-holder, yet its workspace is the Chat's own.
 */
export function usesSharedWorkspace(task: AgentTask): boolean {
  return subjectForTask(task).kind !== "issue" || holdsWorkspace(task);
}

/**
 * The lane whose private directory an execution starts in, or null when it
 * starts in its workspace.
 *
 * Holders of one Issue run concurrently on the shared workspace, so the files
 * that differ per execution (task context, skill directories, attachments)
 * live in the lane's own `work/` directory, while repositories and the Wiki
 * stay in `work/<issue>` and are reached by absolute path. A Chat has a single
 * serial lane and starts in its workspace, a discussion's workspace already is
 * its lane directory, and a Runtime workspace is the user's own directory.
 */
export function executionLaneForTask(task: AgentTask): LaneIdentity | null {
  if (task.runtimeWorkspaceId || !holdsWorkspace(task) || subjectForTask(task).kind !== "issue") return null;
  return laneForTask(task);
}

export function registryRoot(root: string): string {
  return join(resolve(root), REGISTRY_DIRECTORY);
}

export function registryFile(root: string, subject: StorageSubjectRef): string {
  return join(registryRoot(root), `${segment(subject.id, "subject id")}.json`);
}

export function registrySnapshotDirectory(root: string, subject: StorageSubjectRef): string {
  return join(registryRoot(root), `${segment(subject.id, "subject id")}.snapshot`);
}

export function registrySnapshotWikiDirectory(root: string, subject: StorageSubjectRef): string {
  return join(registrySnapshotDirectory(root, subject), "wiki");
}

/** Written once the pre-ADR-0017 layout has been swept aside. */
export function layoutMarkerFile(root: string): string {
  return join(registryRoot(root), ".layout-v1");
}

export function workRoot(root: string): string {
  return join(resolve(root), WORK_DIRECTORY);
}

/**
 * The subject's shared workspace: repositories, `wiki/` and `.multiremi/wiki-base/`.
 * `MULTIREMI_WORKSPACE_ROOT` points here. A Chat starts in it; an Issue holder
 * starts in its lane's `laneWorkDirectory` instead (see `executionLaneForTask`).
 */
export function workDirectory(root: string, subject: StorageSubjectRef): string {
  return join(workRoot(root), segment(subject.id, "subject id"));
}

/** The subject whose work directory `workDir` is, or null when it is anything else. */
export function subjectIdOfWorkDirectory(root: string, workDir: string): string | null {
  const resolved = resolve(workDir);
  return dirname(resolved) === workRoot(root) ? basename(resolved) : null;
}

export function envRoot(root: string): string {
  return join(resolve(root), ENV_DIRECTORY);
}

export function envDirectory(root: string, subject: StorageSubjectRef): string {
  return join(envRoot(root), segment(subject.id, "subject id"));
}

/** Everything one lane generation owns: provider home, discussion work set, plugin runtime. */
export function laneGenerationDirectory(root: string, lane: LaneIdentity): string {
  return join(
    envDirectory(root, lane.subject),
    segment(lane.conversation, "conversation id"),
    segment(lane.agentId, "agent id"),
    lane.scope ? segment(lane.scope, "execution scope") : MAIN_SCOPE,
    String(lane.generation),
  );
}

/**
 * A lane generation's own `work/` directory, rebuilt with the generation: the
 * work set of a discussion, or the cwd of an Issue holder (task context, skill
 * directories and attachments only).
 */
export function laneWorkDirectory(root: string, lane: LaneIdentity): string {
  return laneGenerationWorkDirectory(laneGenerationDirectory(root, lane));
}

/** The `work/` directory of a lane generation found by listing `env/`. */
export function laneGenerationWorkDirectory(generationPath: string): string {
  return join(generationPath, "work");
}

/**
 * A path below the workspaces root with `/` separators. Snapshot entries of trees
 * outside `work/<subject>/` (a lane generation below `env/`) record where their
 * worktree stood this way; restore never maps such a path to a worktree.
 */
export function rootRelative(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

/**
 * Whether a snapshot entry's `dir` is the place of a worktree in one of the subject's
 * lane generations (`rootRelative` of a path below `env/<subject>/`). Nothing can be
 * restored into a new generation, so such an entry only tells where the saved work
 * is. A repository called `env` in the work directory is not one: its `dir` is not
 * below `env/<subject>/`.
 */
export function isLaneSnapshotDir(subject: StorageSubjectRef, dir: string): boolean {
  return dir.startsWith(`${ENV_DIRECTORY}/${segment(subject.id, "subject id")}/`);
}

/** Directory that owns `.remi-runtime` for executions of a lane generation. */
export function pluginRuntimeBaseDirectory(root: string, lane: LaneIdentity): string {
  return laneGenerationDirectory(root, lane);
}

/** Parent of the execution-private temp directories of a subject. */
export function taskTmpRoot(root: string, subject: StorageSubjectRef): string {
  return join(envDirectory(root, subject), TASK_TMP_DIRECTORY);
}

export function tracesRoot(root: string): string {
  return join(resolve(root), TRACES_DIRECTORY);
}

export function traceDirectory(root: string, subject: StorageSubjectRef | string): string {
  return join(tracesRoot(root), segment(typeof subject === "string" ? subject : subject.id, "subject id"));
}

export function tracePath(root: string, subject: StorageSubjectRef | string, taskId: string): string {
  return join(traceDirectory(root, subject), `${segment(taskId, "task id")}.jsonl`);
}

export function sharedRoot(root: string): string {
  return join(resolve(root), SHARED_DIRECTORY);
}

/** Bare repository cache (`MULTIREMI_REPO_CACHE_ROOT` default); snapshot refs live here. */
export function sharedReposRoot(root: string): string {
  return join(sharedRoot(root), "repos");
}

/** Read-only commit views used by intake workspaces. */
export function codeViewsRoot(root: string): string {
  return join(sharedRoot(root), "code-views");
}

export function daemonRoot(root: string): string {
  return join(resolve(root), DAEMON_DIRECTORY);
}

export function probeRoot(root: string): string {
  return join(daemonRoot(root), "probe");
}

export function quarantineRoot(root: string): string {
  return join(daemonRoot(root), QUARANTINE_DIRECTORY);
}

/** Latest completed disk measurement (`measured_at` and per-category bytes). */
export function diskUsageFile(root: string): string {
  return join(daemonRoot(root), "disk-usage.json");
}

/** Reclaim reports the server has not acknowledged yet. */
export function pendingReportsRoot(root: string): string {
  return join(daemonRoot(root), "reports");
}

export function topicsRoot(root: string): string {
  return join(resolve(root), TOPICS_DIRECTORY);
}

/** A `legacy-<date>` directory found by listing the root. */
export function legacyEntryPath(root: string, name: string): string {
  if (!name.startsWith(LEGACY_DIRECTORY_PREFIX)) throw new Error(`not a legacy directory: ${name}`);
  return join(resolve(root), name);
}

/** Worktrees of one `legacy-<date>` directory whose snapshot failed. */
export function legacyRetainedDirectory(legacyDir: string): string {
  return join(legacyDir, LEGACY_RETAINED_DIRECTORY);
}

export function legacyRetainedList(legacyDir: string): string {
  return join(legacyDir, LEGACY_RETAINED_LIST);
}

export function legacyDirectory(root: string, date: Date): string {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return join(resolve(root), `${LEGACY_DIRECTORY_PREFIX}${day}`);
}

/** Path segment for an id; throws instead of silently merging two different ids. */
export function segment(value: string, label: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`invalid ${label} for workspace path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
