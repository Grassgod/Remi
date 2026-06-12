/**
 * Issue-scoped task + timeline routes — port of the Go handlers the issue
 * detail page calls (server/internal/handler/daemon.go + activity.go):
 *
 *   GET  /api/issues/:id/active-task          → GetActiveTaskForIssue: { tasks: [...] }
 *   GET  /api/issues/:id/task-runs            → ListTasksByIssue: AgentTaskResponse[]
 *   GET  /api/issues/:id/usage                → GetIssueUsage: aggregated token totals
 *   GET  /api/issues/:id/timeline             → ListTimeline: comments + activities merged
 *   POST /api/issues/:id/tasks/:taskId/cancel → CancelTask: cancel a queued/running task
 *
 * Declared on absolute /api/issues/:id/* paths in a standalone factory so it
 * composes alongside issueRoutes without editing that file (same shape as
 * issueMetadataRoutes). Behind the /api/* JWT gate; scoped to a workspace via
 * X-Workspace-ID + a membership check; the :id path param accepts a UUID or a
 * human identifier ("MUL-123"), resolved inside the workspace (the Go
 * loadIssueForUser gate), so cross-workspace probes 404.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Comment, Issue } from "../../db/schema.js";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import { getAgentTask } from "../../db/queries/daemontasks.js";
import {
  cancelAgentTask,
  getIssueUsageSummary,
  listActiveTasksByIssue,
  listAttachmentsByCommentIds,
  listReactionsByCommentIds,
  listTasksByIssue,
  type AgentTask,
  type Attachment,
  type CommentReaction,
} from "../../db/queries/issueTasks.js";
import { listCommentsForIssue } from "../../db/queries/comments.js";
import { listActivitiesForIssue, type ActivityLog } from "../../db/queries/activity.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/**
 * Resolve the issue in the path within the workspace (loadIssueForUser
 * equivalent — accepts a UUID or "MUL-123"). Returns the issue or a 404
 * Response.
 */
async function requireIssue(c: Context<AppEnv>, db: Db, wsId: string): Promise<Issue | Response> {
  const idParam = c.req.param("id") ?? "";
  const found = await getIssueByIdentifier(db, wsId, idParam);
  if (!found) return c.json({ error: "issue not found" }, 404);
  return found;
}

/** Mirrors Go shortTaskID: first 8 hex chars of the UUID with dashes stripped. */
function shortTaskId(uuid: string): string {
  const s = uuid.replaceAll("-", "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * Matches the well-known per-user home layouts after backslash normalization
 * (`/Users/<name>/...`, `/home/<name>/...`, `<drive>:/Users/<name>/...`),
 * capture group 1 = optional remainder after the username segment. Mirrors the
 * Go homeDirPattern (case-insensitive).
 */
const HOME_DIR_RE = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?:\/(.*))?$/i;

/**
 * Privacy-safe display form of the daemon-reported absolute work_dir (mirrors
 * Go relativeWorkDir): strip up to the `<wsUUID>/<taskShort>` envRoot suffix
 * for standard tasks; for local_directory tasks strip recognised home-dir
 * prefixes; otherwise fall back to the basename. Never returns the user's home
 * prefix or account name. Empty when work_dir is empty or stripping leaves
 * nothing.
 */
function relativeWorkDir(workDir: string | null, workspaceId: string, taskId: string): string {
  if (!workDir) return "";
  const normalized = workDir.replaceAll("\\", "/");

  if (workspaceId && taskId) {
    const envRootSuffix = `${workspaceId}/${shortTaskId(taskId)}`;
    const idx = normalized.indexOf(envRootSuffix);
    if (idx >= 0) return normalized.slice(idx);
  }

  const m = HOME_DIR_RE.exec(normalized);
  if (m) return m[1] ?? "";

  const trimmed = normalized.replace(/\/+$/, "");
  if (!trimmed) return "";
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Source discriminator for the activity UI (mirrors Go computeTaskKind):
 * chat / autopilot / quick_create (no linked source) / comment (triggered on
 * an issue) / direct (assignee-driven task on an existing issue).
 */
function computeTaskKind(t: AgentTask): string {
  if (t.chatSessionId) return "chat";
  if (t.autopilotRunId) return "autopilot";
  if (!t.issueId) return "quick_create";
  if (t.triggerCommentId) return "comment";
  return "direct";
}

/**
 * Mirrors the Go AgentTaskResponse wire shape (snake_case, exact omitempty
 * semantics: undefined fields are dropped by JSON.stringify, matching Go's
 * omitted keys; the no-omitempty fields serialize null when unset).
 */
function taskToResponse(t: AgentTask, workspaceId: string) {
  return {
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    issue_id: t.issueId ?? "",
    workspace_id: workspaceId,
    status: t.status,
    priority: t.priority,
    dispatched_at: t.dispatchedAt,
    started_at: t.startedAt,
    completed_at: t.completedAt,
    result: t.result ?? null,
    error: t.error,
    failure_reason: t.failureReason ?? undefined,
    attempt: t.attempt,
    max_attempts: t.maxAttempts,
    parent_task_id: t.parentTaskId ?? undefined,
    created_at: t.createdAt,
    trigger_comment_id: t.triggerCommentId ?? undefined,
    trigger_summary: t.triggerSummary ?? undefined,
    work_dir: t.workDir || undefined,
    relative_work_dir: relativeWorkDir(t.workDir, workspaceId, t.id) || undefined,
    chat_session_id: t.chatSessionId ?? undefined,
    autopilot_run_id: t.autopilotRunId ?? undefined,
    kind: computeTaskKind(t),
  };
}

/** Mirrors the Go ReactionResponse shape (reaction.go). */
function reactionToResponse(r: CommentReaction) {
  return {
    id: r.id,
    comment_id: r.commentId,
    actor_type: r.actorType,
    actor_id: r.actorId,
    emoji: r.emoji,
    created_at: r.createdAt,
  };
}

/** Mirrors the Go AttachmentResponse shape (file.go, proxy download path). */
function attachmentToResponse(a: Attachment) {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    issue_id: a.issueId,
    comment_id: a.commentId,
    chat_session_id: a.chatSessionId,
    chat_message_id: a.chatMessageId,
    uploader_type: a.uploaderType,
    uploader_id: a.uploaderId,
    filename: a.filename,
    url: a.url,
    download_url: `/api/attachments/${a.id}/download`,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt,
  };
}

/** One merged timeline row — the union of the comment and activity shapes. */
interface TimelineEntry {
  type: "activity" | "comment";
  id: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  action?: string;
  details?: unknown;
  content?: string;
  parent_id?: string;
  updated_at?: string;
  comment_type?: string;
  reactions?: ReturnType<typeof reactionToResponse>[];
  attachments?: ReturnType<typeof attachmentToResponse>[];
  resolved_at?: string;
  resolved_by_type?: string;
  resolved_by_id?: string;
}

/** Comment → TimelineEntry with reactions/attachments enrichment (Go commentsToEntries). */
function commentToEntry(
  cm: Comment,
  reactions: Map<string, ReturnType<typeof reactionToResponse>[]>,
  attachments: Map<string, ReturnType<typeof attachmentToResponse>[]>,
): TimelineEntry {
  return {
    type: "comment",
    id: cm.id,
    actor_type: cm.authorType,
    actor_id: cm.authorId,
    created_at: cm.createdAt,
    content: cm.content,
    comment_type: cm.type,
    parent_id: cm.parentId ?? undefined,
    updated_at: cm.updatedAt,
    reactions: reactions.get(cm.id),
    attachments: attachments.get(cm.id),
    resolved_at: cm.resolvedAt ?? undefined,
    resolved_by_type: cm.resolvedByType ?? undefined,
    resolved_by_id: cm.resolvedById ?? undefined,
  };
}

/** ActivityLog → TimelineEntry (Go activityToEntry). */
function activityToEntry(a: ActivityLog): TimelineEntry {
  return {
    type: "activity",
    id: a.id,
    actor_type: a.actorType ?? "",
    actor_id: a.actorId ?? "",
    created_at: a.createdAt,
    action: a.action,
    details: a.details ?? {},
  };
}

/**
 * Sort merged entries by (created_at, id) — ascending for the flat contract,
 * descending for the legacy wrapped contract (Go mergeTimeline).
 */
function sortEntries(entries: TimelineEntry[], ascending: boolean): TimelineEntry[] {
  entries.sort((x, y) => {
    if (x.created_at !== y.created_at) {
      if (ascending) return x.created_at < y.created_at ? -1 : 1;
      return x.created_at > y.created_at ? -1 : 1;
    }
    if (ascending) return x.id < y.id ? -1 : 1;
    return x.id > y.id ? -1 : 1;
  });
  return entries;
}

export function issueTasksRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/issues/:id/active-task — all currently active tasks for an issue.
  // Always { tasks: [...] } (may be empty); backs the issue-detail live banner.
  r.get("/api/issues/:id/active-task", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const tasks = await listActiveTasksByIssue(db, issue.id);
    return c.json({ tasks: tasks.map((t) => taskToResponse(t, ws)) });
  });

  // GET /api/issues/:id/task-runs — all tasks (any status), newest first.
  // Bare array; powers the execution-history list.
  r.get("/api/issues/:id/task-runs", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const tasks = await listTasksByIssue(db, issue.id);
    return c.json(tasks.map((t) => taskToResponse(t, ws)));
  });

  // GET /api/issues/:id/usage — aggregated token usage across the issue's tasks.
  r.get("/api/issues/:id/usage", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const row = await getIssueUsageSummary(db, issue.id);
    // bigint sums arrive as strings from postgres-js — normalize at the wire.
    return c.json({
      total_input_tokens: Number(row.totalInputTokens),
      total_output_tokens: Number(row.totalOutputTokens),
      total_cache_read_tokens: Number(row.totalCacheReadTokens),
      total_cache_write_tokens: Number(row.totalCacheWriteTokens),
      task_count: Number(row.taskCount),
    });
  });

  // GET /api/issues/:id/timeline — the full issue timeline (comments +
  // activities merged). Two response shapes coexist for boundary compatibility
  // (Go #1929): no pagination params → flat ASC TimelineEntry[]; any of
  // limit/before/after/around present → wrapped object with DESC entries +
  // null cursors + has_more_*=false (cursor-walking is a no-op — the server
  // returns the whole timeline in one shot).
  r.get("/api/issues/:id/timeline", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const [comments, activities] = await Promise.all([
      listCommentsForIssue(db, issue.id, ws),
      listActivitiesForIssue(db, issue.id),
    ]);

    // Batch-enrich comments with reactions + attachments (Go commentsToEntries).
    const commentIds = comments.map((cm) => cm.id);
    const [reactions, attachments] = await Promise.all([
      listReactionsByCommentIds(db, commentIds),
      listAttachmentsByCommentIds(db, commentIds, ws),
    ]);
    const reactionsByComment = new Map<string, ReturnType<typeof reactionToResponse>[]>();
    for (const rx of reactions) {
      const list = reactionsByComment.get(rx.commentId) ?? [];
      list.push(reactionToResponse(rx));
      reactionsByComment.set(rx.commentId, list);
    }
    const attachmentsByComment = new Map<string, ReturnType<typeof attachmentToResponse>[]>();
    for (const a of attachments) {
      if (!a.commentId) continue;
      const list = attachmentsByComment.get(a.commentId) ?? [];
      list.push(attachmentToResponse(a));
      attachmentsByComment.set(a.commentId, list);
    }

    const merged = [
      ...comments.map((cm) => commentToEntry(cm, reactionsByComment, attachmentsByComment)),
      ...activities.map(activityToEntry),
    ];

    const q = (k: string) => c.req.query(k) ?? "";
    const wantWrapped =
      q("limit") !== "" || q("before") !== "" || q("after") !== "" || q("around") !== "";

    if (wantWrapped) {
      const entries = sortEntries(merged, false);
      // `around=<id>`: locate the anchor in the DESC slice so the legacy client
      // can scroll-to-highlight without a follow-up request.
      let targetIndex: number | undefined;
      const anchor = q("around");
      if (anchor !== "") {
        const idx = entries.findIndex((e) => e.id === anchor);
        if (idx >= 0) targetIndex = idx;
      }
      return c.json({
        entries,
        next_cursor: null,
        prev_cursor: null,
        has_more_before: false,
        has_more_after: false,
        ...(targetIndex !== undefined ? { target_index: targetIndex } : {}),
      });
    }

    return c.json(sortEntries(merged, true));
  });

  // POST /api/issues/:id/tasks/:taskId/cancel — cancel a running or queued
  // task. Verifies both that the URL-parameter issue belongs to the caller's
  // workspace and that the task belongs to that same issue — a task UUID from
  // a different issue (in any workspace) must not be cancellable through this
  // route (Go CancelTask).
  r.post("/api/issues/:id/tasks/:taskId/cancel", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    const taskId = c.req.param("taskId") ?? "";
    if (!UUID_RE.test(taskId)) return c.json({ error: "invalid task id" }, 400);

    const existing = await getAgentTask(db, taskId);
    if (!existing || existing.issueId !== issue.id) {
      return c.json({ error: "task not found" }, 404);
    }

    const cancelled = await cancelAgentTask(db, taskId);
    if (!cancelled) {
      // Already terminal — idempotent success: return the current row, no event
      // (mirrors the Go TaskService.CancelTask ErrNoRows branch).
      const current = await getAgentTask(db, taskId);
      if (!current) return c.json({ error: "task not found" }, 404);
      return c.json(taskToResponse(current, ws));
    }

    // Broadcast so frontends clear the live card (Go broadcastTaskEvent with
    // protocol.EventTaskCancelled).
    const payload: Record<string, unknown> = {
      task_id: cancelled.id,
      agent_id: cancelled.agentId,
      issue_id: cancelled.issueId ?? "",
      status: cancelled.status,
    };
    if (cancelled.chatSessionId) payload.chat_session_id = cancelled.chatSessionId;
    bus.publish({ type: "task:cancelled", workspaceId: ws, payload });

    return c.json(taskToResponse(cancelled, ws));
  });

  return r;
}
