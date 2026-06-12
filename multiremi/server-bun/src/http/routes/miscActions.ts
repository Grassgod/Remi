/**
 * Misc single-resource action routes — the grab-bag of endpoints the frontend
 * calls that the existing routers don't cover. Ports of:
 *
 *   GET    /api/labels/:id              → label.go GetLabel
 *   PUT    /api/labels/:id              → label.go UpdateLabel
 *   DELETE /api/labels/:id              → label.go DeleteLabel
 *   POST   /api/issues/:id/subscribe    → subscriber.go SubscribeToIssue
 *   POST   /api/issues/:id/unsubscribe  → subscriber.go UnsubscribeFromIssue
 *   POST   /api/issues/:id/rerun        → task_lifecycle.go RerunIssue
 *   POST   /api/inbox/:id/archive       → inbox.go ArchiveInboxItem
 *   DELETE /api/attachments/:id         → file.go DeleteAttachment
 *   GET    /api/attachments/:id/content → file.go GetAttachmentContent
 *   GET    /api/tasks/:taskId/messages  → daemon.go ListTaskMessagesByUser
 *   POST   /api/tasks/:taskId/cancel    → chat.go CancelTaskByUser
 *   /api/tokens (GET / POST / DELETE :id) → personal_access_token.go, served
 *     by re-mounting the existing patRoutes factory at the /api/tokens path
 *     the frontend actually calls (pat.ts is mounted at
 *     /api/personal-access-tokens, which nothing in client.ts uses).
 *
 * Declared on absolute /api/* paths in a standalone factory (mount at "/")
 * so it composes alongside the existing routers without editing them. Behind
 * the /api/* JWT gate; workspace-scoped routes use X-Workspace-ID + a
 * membership check; issue :id accepts a UUID or a human identifier
 * ("MUL-123"), resolved inside the workspace (the Go loadIssueForUser gate).
 *
 * Helpers that exist un-exported in sibling route files (taskToResponse,
 * labelToResponse, isUniqueViolation, the label validators) are mirrored here
 * rather than imported — those files must not be modified.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue, Member } from "../../db/schema.js";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import { getLabel } from "../../db/queries/labels.js";
import { getAgent } from "../../db/queries/comments.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import { getSquadInWorkspace } from "../../db/queries/squads.js";
import { getChatSessionInWorkspace } from "../../db/queries/chat.js";
import { getInboxItemInWorkspace, getIssueStatus } from "../../db/queries/inbox.js";
import { getAttachment } from "../../db/queries/attachments.js";
import { getAgentTask } from "../../db/queries/daemontasks.js";
import { addIssueSubscriber, removeIssueSubscriber } from "../../db/queries/subscribers.js";
import { cancelAgentTask } from "../../db/queries/issueTasks.js";
import {
  archiveInboxByIssue,
  archiveInboxItem,
  cancelAgentTasksByIssueAndAgent,
  createAgentTask,
  deleteAttachmentRow,
  deleteLabel,
  getAgentTaskInWorkspace,
  listTaskMessages,
  resolveTaskWorkspaceId,
  updateLabel,
  type AgentTask,
  type InboxItem,
  type Label,
} from "../../db/queries/miscActions.js";
import type { Storage } from "../../storage/storage.js";
import { LocalStorage } from "../../storage/local.js";
import { bus } from "../../realtime/bus.js";
import { patRoutes } from "./pat.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared gates
// ---------------------------------------------------------------------------

/**
 * Resolve + authorize the workspace for this request. Returns the workspace
 * UUID and the caller's member row (needed for role checks), or a Response to
 * short-circuit with (400 missing/malformed header, 404 not-a-member —
 * mirrors the Go workspace-member gate).
 */
async function requireWorkspaceMember(
  c: Context<AppEnv>,
  db: Db,
): Promise<{ wsId: string; member: Member } | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return { wsId, member: m };
}

/**
 * Resolve the issue in the path within the workspace (Go loadIssueForUser —
 * accepts a UUID or "MUL-123"). Returns the issue or a 404 Response.
 */
async function requireIssue(c: Context<AppEnv>, db: Db, wsId: string): Promise<Issue | Response> {
  const idParam = c.req.param("id") ?? "";
  const found = await getIssueByIdentifier(db, wsId, idParam);
  if (!found) return c.json({ error: "issue not found" }, 404);
  return found;
}

/**
 * Determine the actor identity: agent (via X-Agent-ID, validated against the
 * workspace and a present X-Task-ID) or member. Mirrors the Go resolveActor
 * subset used elsewhere in the Bun port (reactions.ts) — the agent must exist
 * in the request's workspace, otherwise we fall back to member.
 */
async function resolveActor(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  wsId: string,
): Promise<{ actorType: string; actorId: string }> {
  const agentId = c.req.header("X-Agent-ID");
  if (!agentId || !UUID_RE.test(agentId)) return { actorType: "member", actorId: userId };
  if (!c.req.header("X-Task-ID")) return { actorType: "member", actorId: userId };
  const a = await getAgent(db, agentId);
  if (!a || a.workspaceId !== wsId) return { actorType: "member", actorId: userId };
  return { actorType: "agent", actorId: agentId };
}

/**
 * Whether (userType, userId) is a member or agent of the workspace (Go
 * isWorkspaceEntity). Non-UUID ids short-circuit false instead of reaching a
 * uuid-typed column (mirrors the Go util.ParseUUID error branch).
 */
async function isWorkspaceEntity(
  db: Db,
  userType: string,
  userId: string,
  wsId: string,
): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  if (userType === "member") return (await getMembership(db, userId, wsId)) !== null;
  if (userType === "agent") return (await getAgentInWorkspace(db, wsId, userId)) !== null;
  return false;
}

// ---------------------------------------------------------------------------
// Labels — validation + wire shape (mirrors label.go; the un-exported
// originals live in routes/labels.ts)
// ---------------------------------------------------------------------------

/** 6-digit hex, with or without a leading '#'. Mirrors the Go hexColorRE. */
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

const MAX_LABEL_NAME_LEN = 32;

function labelToResponse(l: Label) {
  return {
    id: l.id,
    workspace_id: l.workspaceId,
    name: l.name,
    color: l.color,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

/** Trim + validate a label name (mirrors the Go validateLabelName). */
function validateLabelName(raw: unknown): { name: string } | { error: string } {
  const name = (typeof raw === "string" ? raw : "").trim();
  if (!name) return { error: "name is required" };
  if (name.length > MAX_LABEL_NAME_LEN) return { error: "name must be 32 characters or fewer" };
  return { name };
}

/**
 * Normalize a color to canonical "#rrggbb" (mirrors the Go normalizeColor).
 *
 * LOAD-BEARING INVARIANT: the frontend LabelChip renders
 * style={{ backgroundColor: color }} directly. Keep this regex strict so the
 * inline style can never become an injection surface.
 */
function normalizeColor(raw: unknown): { color: string } | { error: string } {
  const cc = (typeof raw === "string" ? raw : "").trim();
  if (!HEX_COLOR_RE.test(cc)) {
    return { error: "color must be a 6-digit hex value like #3b82f6" };
  }
  const withHash = cc.startsWith("#") ? cc : `#${cc}`;
  return { color: withHash.toLowerCase() };
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Drizzle
 * wraps driver errors, so the code may live on `cause` — check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}

// ---------------------------------------------------------------------------
// Task wire shape (mirrors the Go AgentTaskResponse; the un-exported original
// lives in routes/issueTasks.ts)
// ---------------------------------------------------------------------------

/** Mirrors Go shortTaskID: first 8 hex chars of the UUID with dashes stripped. */
function shortTaskId(uuid: string): string {
  const s = uuid.replaceAll("-", "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** Well-known per-user home layouts after backslash normalization. */
const HOME_DIR_RE = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?:\/(.*))?$/i;

/** Privacy-safe display form of the daemon-reported work_dir (Go relativeWorkDir). */
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

/** Source discriminator for the activity UI (Go computeTaskKind). */
function computeTaskKind(t: AgentTask): string {
  if (t.chatSessionId) return "chat";
  if (t.autopilotRunId) return "autopilot";
  if (!t.issueId) return "quick_create";
  if (t.triggerCommentId) return "comment";
  return "direct";
}

/** Mirrors the Go AgentTaskResponse wire shape (snake_case, omitempty semantics). */
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

/** Broadcast a task state-change frame (Go broadcastTaskEvent payload shape). */
function publishTaskEvent(type: string, wsId: string, t: AgentTask): void {
  const payload: Record<string, unknown> = {
    task_id: t.id,
    agent_id: t.agentId,
    issue_id: t.issueId ?? "",
    status: t.status,
  };
  if (t.chatSessionId) payload.chat_session_id = t.chatSessionId;
  bus.publish({ type, workspaceId: wsId, payload });
}

/** Go priorityToInt: urgent 4, high 3, medium 2, low 1, else 0. */
function priorityToInt(p: string): number {
  switch (p) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Inbox wire shape (mirrors the Go InboxItemResponse; the un-exported
// original lives in routes/inbox.ts)
// ---------------------------------------------------------------------------

function inboxToResponse(i: InboxItem, issueStatus: string | null) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    recipient_type: i.recipientType,
    recipient_id: i.recipientId,
    type: i.type,
    severity: i.severity,
    issue_id: i.issueId,
    title: i.title,
    body: i.body,
    read: i.read,
    archived: i.archived,
    created_at: i.createdAt,
    issue_status: issueStatus,
    actor_type: i.actorType,
    actor_id: i.actorId,
    details: i.details ?? {},
  };
}

// ---------------------------------------------------------------------------
// Attachment preview whitelist (mirrors Go isTextPreviewable; keep in sync
// with packages/views/editor/utils/preview.ts)
// ---------------------------------------------------------------------------

/** Cap on the body the preview proxy loads into memory (Go maxPreviewTextSize). */
const MAX_PREVIEW_TEXT_SIZE = 2 << 20; // 2 MB

const PREVIEWABLE_CONTENT_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/x-httpd-php",
]);

const PREVIEWABLE_EXTENSIONS = new Set([
  ".md", ".markdown",
  ".txt", ".log",
  ".csv", ".tsv",
  ".html", ".htm",
  ".json", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".conf",
  ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".rs",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less",
  ".sql",
  ".java", ".kt", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".lua", ".vim",
  ".dockerfile", ".makefile", ".gitignore",
]);

const PREVIEWABLE_BASENAMES = new Set(["dockerfile", "makefile", ".env"]);

/**
 * Whitelist for the text preview proxy. Both content_type and extension are
 * checked because detection regularly reports "text/plain" for Markdown /
 * source code, so a pure content-type check would 415 those (mirrors Go).
 */
function isTextPreviewable(contentType: string, filename: string): boolean {
  let ct = contentType.trim().toLowerCase();
  const semi = ct.indexOf(";");
  if (semi >= 0) ct = ct.slice(0, semi).trim();
  if (ct.startsWith("text/")) return true;
  if (PREVIEWABLE_CONTENT_TYPES.has(ct)) return true;

  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  if (PREVIEWABLE_EXTENSIONS.has(ext)) return true;
  return PREVIEWABLE_BASENAMES.has(base.toLowerCase());
}

/** Default blob store for self-host (same default as routes/attachments.ts). */
function defaultStorage(): Storage {
  return new LocalStorage(process.env.MULTIMIRA_STORAGE_DIR ?? join(tmpdir(), "multimira-attachments"));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function miscActionsRoutes(db?: Db, storage: Storage = defaultStorage()): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // /api/tokens — the absolute paths the frontend calls for PAT list/create/
  // revoke (client.ts uses /api/tokens everywhere; the Go router serves the
  // same handler set at /api/tokens). Reuse the existing factory so the
  // behavior is identical to /api/personal-access-tokens.
  r.route("/api/tokens", patRoutes(db));

  // GET /api/labels/:id — single label (Go GetLabel).
  r.get("/api/labels/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid label id" }, 400);
    const label = await getLabel(db, gate.wsId, id);
    if (!label) return c.json({ error: "label not found" }, 404);
    return c.json(labelToResponse(label));
  });

  // PUT /api/labels/:id — partial update of name/color (Go UpdateLabel).
  r.put("/api/labels/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid label id" }, 400);

    // Mirror the Go *string semantics: absent or JSON-null fields are skipped.
    const patch: { name?: string; color?: string } = {};
    if (body.name != null) {
      const res = validateLabelName(body.name);
      if ("error" in res) return c.json({ error: res.error }, 400);
      patch.name = res.name;
    }
    if (body.color != null) {
      const res = normalizeColor(body.color);
      if ("error" in res) return c.json({ error: res.error }, 400);
      patch.color = res.color;
    }

    // Branch on the UPDATE's row count directly — the WHERE already enforces
    // (id, workspace_id), so a missing row is a 404 without a TOCTOU precheck.
    let label: Label | null;
    try {
      label = await updateLabel(db, gate.wsId, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "a label with that name already exists" }, 409);
      }
      throw err;
    }
    if (!label) return c.json({ error: "label not found" }, 404);

    const resp = labelToResponse(label);
    bus.publish({ type: "label:updated", workspaceId: gate.wsId, payload: { label: resp } });
    return c.json(resp);
  });

  // DELETE /api/labels/:id — delete a label (Go DeleteLabel). RETURNING-gated
  // so a row that isn't in this workspace 404s instead of silently 204ing.
  r.delete("/api/labels/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid label id" }, 400);
    const deleted = await deleteLabel(db, gate.wsId, id);
    if (!deleted) return c.json({ error: "label not found" }, 404);
    bus.publish({ type: "label:deleted", workspaceId: gate.wsId, payload: { label_id: id } });
    return c.body(null, 204);
  });

  /**
   * Shared body of subscribe/unsubscribe (Go SubscribeToIssue /
   * UnsubscribeFromIssue): default target = the caller (via resolveActor so an
   * agent caller targets itself); an optional body { user_id, user_type }
   * overrides; the target must be a member/agent of the workspace (403).
   */
  const handleSubscription = async (c: Context<AppEnv>, subscribe: boolean) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const issue = await requireIssue(c, db, gate.wsId);
    if (issue instanceof Response) return issue;

    const caller = await resolveActor(c, db, c.get("user").sub, gate.wsId);
    let targetUserType = caller.actorType;
    let targetUserId = caller.actorId;
    // The Go handler decodes the body and ignores decode errors — an empty or
    // malformed body keeps the caller as the target.
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (typeof body.user_id === "string" && body.user_id) targetUserId = body.user_id;
      if (typeof body.user_type === "string" && body.user_type) targetUserType = body.user_type;
    } catch {
      /* optional body */
    }

    if (!(await isWorkspaceEntity(db, targetUserType, targetUserId, gate.wsId))) {
      return c.json({ error: "target user is not a member of this workspace" }, 403);
    }

    if (subscribe) {
      await addIssueSubscriber(db, {
        issueId: issue.id,
        userType: targetUserType,
        userId: targetUserId,
        reason: "manual",
      });
      bus.publish({
        type: "subscriber:added",
        workspaceId: gate.wsId,
        payload: {
          issue_id: issue.id,
          user_type: targetUserType,
          user_id: targetUserId,
          reason: "manual",
        },
      });
      return c.json({ subscribed: true });
    }

    await removeIssueSubscriber(db, {
      issueId: issue.id,
      userType: targetUserType,
      userId: targetUserId,
    });
    bus.publish({
      type: "subscriber:removed",
      workspaceId: gate.wsId,
      payload: { issue_id: issue.id, user_type: targetUserType, user_id: targetUserId },
    });
    return c.json({ subscribed: false });
  };

  // POST /api/issues/:id/subscribe — subscribe the caller (or body target).
  r.post("/api/issues/:id/subscribe", (c) => handleSubscription(c, true));

  // POST /api/issues/:id/unsubscribe — remove the subscription.
  r.post("/api/issues/:id/unsubscribe", (c) => handleSubscription(c, false));

  // POST /api/issues/:id/rerun — manually re-enqueue an agent run for the
  // issue (Go RerunIssue). Default target: the issue's current assignee
  // (agent, or squad leader); body { task_id } retargets the agent that ran
  // that past task. Prior active tasks of the target agent on this issue are
  // cancelled; the fresh task carries force_fresh_session=true so the daemon
  // starts a clean session. All service-level failures surface as 400 with
  // the reason (mirrors the Go handler's writeError(400, err.Error())).
  r.post("/api/issues/:id/rerun", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const issue = await requireIssue(c, db, gate.wsId);
    if (issue instanceof Response) return issue;

    // Body is optional: zero-length or `{}` keeps the assignee-driven rerun.
    let sourceTaskId = "";
    const raw = await c.req.text();
    if (raw.length > 0) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return c.json({ error: "invalid request body" }, 400);
      }
      if (typeof body.task_id === "string" && body.task_id) {
        if (!UUID_RE.test(body.task_id)) return c.json({ error: "invalid task_id" }, 400);
        sourceTaskId = body.task_id;
      }
    }

    // Resolve the target agent + leader role (Go TaskService.RerunIssue).
    let agentId: string;
    let isLeader = false;
    let triggerCommentId: string | null = null;
    let triggerSummary: string | null = null;
    if (sourceTaskId) {
      const sourceTask = await getAgentTask(db, sourceTaskId);
      if (!sourceTask) return c.json({ error: "load source task: not found" }, 400);
      if (!sourceTask.issueId || sourceTask.issueId !== issue.id) {
        return c.json({ error: "source task does not belong to this issue" }, 400);
      }
      agentId = sourceTask.agentId;
      isLeader = sourceTask.isLeaderTask;
      // Inherit trigger provenance so a per-row rerun of a comment-triggered
      // task stays comment-triggered (the Go path re-derives the summary from
      // the same comment; inheriting the stored value is equivalent).
      triggerCommentId = sourceTask.triggerCommentId;
      triggerSummary = sourceTask.triggerSummary;
    } else if (issue.assigneeType === "agent" && issue.assigneeId) {
      agentId = issue.assigneeId;
    } else if (issue.assigneeType === "squad" && issue.assigneeId) {
      const squad = await getSquadInWorkspace(db, gate.wsId, issue.assigneeId);
      if (!squad) return c.json({ error: "issue is assigned to a squad but squad not found" }, 400);
      agentId = squad.leaderId;
      isLeader = true;
    } else {
      return c.json({ error: "issue is not assigned to an agent or squad" }, 400);
    }

    // The agent must be live + claimable (Go enqueueIssueTask/enqueueMentionTask
    // guards). Workspace-scoped lookup: the assignee always lives in the
    // issue's workspace, and a cross-workspace source task already 400'd above.
    const ag = await getAgentInWorkspace(db, gate.wsId, agentId);
    if (!ag) return c.json({ error: "load agent: not found" }, 400);
    if (ag.archivedAt) return c.json({ error: "agent is archived" }, 400);
    if (!ag.runtimeId) return c.json({ error: "agent has no runtime" }, 400);

    // Cancel only the target agent's active tasks on this issue (also keeps
    // the one-pending-task-per-(issue,agent) partial unique index satisfied).
    const cancelled = await cancelAgentTasksByIssueAndAgent(db, issue.id, agentId);
    for (const t of cancelled) publishTaskEvent("task:cancelled", gate.wsId, t);

    const task = await createAgentTask(db, {
      agentId,
      runtimeId: ag.runtimeId,
      issueId: issue.id,
      status: "queued",
      priority: priorityToInt(issue.priority),
      triggerCommentId,
      triggerSummary,
      isLeaderTask: isLeader,
      forceFreshSession: true,
    });
    publishTaskEvent("task:queued", gate.wsId, task);

    return c.json(taskToResponse(task, gate.wsId), 202);
  });

  // POST /api/inbox/:id/archive — archive one inbox item plus its sibling
  // items for the same issue (Go ArchiveInboxItem). Like the other inbox
  // routes, authorization is by recipient (the item must be addressed to the
  // caller), not by a workspace-membership check.
  r.post("/api/inbox/:id/archive", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
    if (!wsId || !UUID_RE.test(wsId)) {
      return c.json({ error: "X-Workspace-ID header required" }, 400);
    }
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid inbox item id" }, 400);

    const userId = c.get("user").sub;
    const prev = await getInboxItemInWorkspace(db, wsId, id);
    if (!prev || prev.recipientType !== "member" || prev.recipientId !== userId) {
      return c.json({ error: "inbox item not found" }, 404);
    }

    const item = await archiveInboxItem(db, prev.id);

    // Issue-level archive: sweep the recipient's other items for that issue.
    if (item.issueId) {
      await archiveInboxByIssue(db, {
        workspaceId: item.workspaceId,
        recipientType: item.recipientType,
        recipientId: item.recipientId,
        issueId: item.issueId,
      });
    }

    bus.publish({
      type: "inbox:archived",
      workspaceId: item.workspaceId,
      payload: { item_id: item.id, issue_id: item.issueId, recipient_id: item.recipientId },
    });

    const issueStatus = item.issueId ? await getIssueStatus(db, item.issueId) : null;
    return c.json(inboxToResponse(item, issueStatus));
  });

  // DELETE /api/attachments/:id — only the uploader or a workspace owner/admin
  // may delete (Go DeleteAttachment). The blob itself is left to the storage
  // backend's lifecycle (the Bun Storage iface has no delete; the Go side's
  // S3 object delete is best-effort cleanup, not part of the contract).
  r.delete("/api/attachments/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid attachment id" }, 400);

    const att = await getAttachment(db, gate.wsId, id);
    if (!att) return c.json({ error: "attachment not found" }, 404);

    const userId = c.get("user").sub;
    const isUploader = att.uploaderType === "member" && att.uploaderId === userId;
    const isAdmin = gate.member.role === "admin" || gate.member.role === "owner";
    if (!isUploader && !isAdmin) {
      return c.json({ error: "not authorized to delete this attachment" }, 403);
    }

    await deleteAttachmentRow(db, att.workspaceId, att.id);
    return c.body(null, 204);
  });

  // GET /api/attachments/:id/content — raw bytes of a text-previewable
  // attachment, served inline (Go GetAttachmentContent). Always text/plain so
  // a hostile HTML payload can't be re-interpreted as a document; the original
  // MIME ships in X-Original-Content-Type for the client-side dispatcher.
  r.get("/api/attachments/:id/content", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid attachment id" }, 400);

    const att = await getAttachment(db, gate.wsId, id);
    if (!att) return c.json({ error: "attachment not found" }, 404);

    if (!isTextPreviewable(att.contentType, att.filename)) {
      return c.json({ error: "preview not supported for this file type" }, 415);
    }

    const blob = await storage.read(storage.keyFromUrl(att.url));
    if (!blob) return c.json({ error: "attachment object not found" }, 404);
    if (blob.data.byteLength > MAX_PREVIEW_TEXT_SIZE) {
      return c.json({ error: "file too large for inline preview" }, 413);
    }

    // Cast: Bun types Uint8Array as <ArrayBufferLike>, which the DOM BodyInit
    // lib type doesn't accept directly though the runtime handles it fine.
    return new Response(blob.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Original-Content-Type": att.contentType,
        // No-store: membership / attachment ACL can change between requests;
        // a cached body would stay readable past the revocation window.
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(blob.data.byteLength),
      },
    });
  });

  // GET /api/tasks/:taskId/messages — the task transcript for the issue
  // activity view, under regular user auth (Go ListTaskMessagesByUser). The
  // task's resolved workspace must match the caller's workspace, otherwise a
  // UUID probe from another tenant 404s. Optional ?since=<seq> returns only
  // rows with seq > since.
  r.get("/api/tasks/:taskId/messages", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const taskId = c.req.param("taskId");
    if (!UUID_RE.test(taskId)) return c.json({ error: "invalid task_id" }, 400);

    const task = await getAgentTask(db, taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const taskWs = await resolveTaskWorkspaceId(db, task);
    if (!taskWs || taskWs !== gate.wsId) return c.json({ error: "task not found" }, 404);

    let sinceSeq: number | undefined;
    const sinceStr = c.req.query("since") ?? "";
    if (sinceStr !== "") {
      if (!/^-?\d+$/.test(sinceStr)) return c.json({ error: "invalid since parameter" }, 400);
      sinceSeq = Number.parseInt(sinceStr, 10);
    }

    const messages = await listTaskMessages(db, taskId, sinceSeq);
    const issueId = task.issueId ?? "";
    // Mirrors the Go protocol.TaskMessagePayload omitempty semantics: empty
    // strings / null input are omitted keys, not nulls.
    return c.json(
      messages.map((m) => ({
        task_id: taskId,
        issue_id: issueId || undefined,
        seq: m.seq,
        type: m.type,
        tool: m.tool || undefined,
        content: m.content || undefined,
        input: m.input ?? undefined,
        output: m.output || undefined,
      })),
    );
  });

  // POST /api/tasks/:taskId/cancel — cancel a task by bare id (Go
  // CancelTaskByUser). Tenancy is enforced through the task's owning agent;
  // chat tasks are private to the conversation's creator; every other task
  // mirrors the private-agent visibility gate.
  r.post("/api/tasks/:taskId/cancel", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const taskId = c.req.param("taskId");
    if (!UUID_RE.test(taskId)) return c.json({ error: "invalid task id" }, 400);

    const task = await getAgentTaskInWorkspace(db, gate.wsId, taskId);
    if (!task) return c.json({ error: "task not found" }, 404);

    const userId = c.get("user").sub;
    if (task.chatSessionId) {
      // Chat privacy: only the member who opened the conversation may cancel
      // its task, even though the workspace is shared.
      const cs = await getChatSessionInWorkspace(db, gate.wsId, task.chatSessionId);
      if (!cs) return c.json({ error: "task not found" }, 404);
      if (cs.creatorId !== userId) return c.json({ error: "not your task" }, 403);
    } else {
      // Mirror the private-agent gate of the surfaces that expose the task
      // (Go canAccessPrivateAgent): non-private agents pass; agent actors
      // pass; the owner passes; owners/admins pass.
      const ag = await getAgentInWorkspace(db, gate.wsId, task.agentId);
      if (!ag) return c.json({ error: "task not found" }, 404);
      if (ag.visibility === "private") {
        const actor = await resolveActor(c, db, userId, gate.wsId);
        const allowed =
          actor.actorType === "agent" ||
          ag.ownerId === actor.actorId ||
          gate.member.role === "owner" ||
          gate.member.role === "admin";
        if (!allowed) return c.json({ error: "you do not have access to this agent" }, 403);
      }
    }

    const cancelled = await cancelAgentTask(db, taskId);
    if (!cancelled) {
      // Already terminal — idempotent success: return the current row, no
      // event (mirrors the Go TaskService.CancelTask ErrNoRows branch).
      const current = await getAgentTask(db, taskId);
      if (!current) return c.json({ error: "task not found" }, 404);
      return c.json(taskToResponse(current, gate.wsId));
    }

    publishTaskEvent("task:cancelled", gate.wsId, cancelled);
    return c.json(taskToResponse(cancelled, gate.wsId));
  });

  return r;
}
