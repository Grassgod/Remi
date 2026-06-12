/**
 * Comment routes (read path) — port of the Go comment handler's
 * GET /api/issues/{id}/comments (list) and POST /api/issues/{id}/comments
 * (create). Behind the /api/* JWT gate; scoped to a workspace via the
 * X-Workspace-ID header + a membership check (multi-tenancy). The issue in the
 * path is resolved within the workspace first (loadIssueForUser equivalent).
 *
 * Mounted at /api/issues/:id/comments, so the issue identifier is available via
 * c.req.param("id"). The router is created with `mergeRoutes` so the parent
 * path param survives into these handlers.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Comment, Issue } from "../../db/schema.js";
import { getIssueByIdentifier } from "../../db/queries/issues.js";
import {
  createComment,
  getAgent,
  getComment,
  getMembership,
  listCommentsForIssue,
  listCommentsForIssueSince,
  listRootCommentsWithStats,
  type RootCommentRow,
} from "../../db/queries/comments.js";
import { enqueueAssigneeOnComment, enqueueMentionedAgentTasks } from "../../agent/commentTrigger.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a comment row to the Go CommentResponse shape (snake_case JSON, exact
 * field names from comment.go). Reactions/attachments default to empty arrays,
 * matching commentToResponse's nil-guard. The omitempty orientation/summary
 * fields (reply_count, last_activity_at, content_truncated) are absent here —
 * they only appear on the roots_only / summary read modes, which this chunk
 * does not port, so omitting them keeps the default response byte-identical.
 */
function commentToResponse(c: Comment) {
  return {
    id: c.id,
    issue_id: c.issueId,
    author_type: c.authorType,
    author_id: c.authorId,
    content: c.content,
    type: c.type,
    parent_id: c.parentId,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    resolved_at: c.resolvedAt,
    resolved_by_type: c.resolvedByType,
    resolved_by_id: c.resolvedById,
    reactions: [] as never[],
    attachments: [] as never[],
  };
}

/** roots_only response: the comment shape + thread orientation stats. */
function rootCommentToResponse(r: RootCommentRow) {
  return { ...commentToResponse(r), reply_count: r.replyCount, last_activity_at: r.lastActivityAt };
}

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
 * equivalent). Returns the issue or a 404 Response.
 */
async function requireIssue(c: Context<AppEnv>, db: Db, wsId: string): Promise<Issue | Response> {
  // The issue identifier comes from the parent mount path (/api/issues/:id/...),
  // so Hono types it as possibly undefined here.
  const idParam = c.req.param("id") ?? "";
  const found = await getIssueByIdentifier(db, wsId, idParam);
  if (!found) return c.json({ error: "issue not found" }, 404);
  return found;
}

/**
 * Determine the author identity for a comment: agent (via X-Agent-ID, validated
 * against the workspace and a present X-Task-ID) or member. Mirrors Go
 * resolveActor's read-path subset — without task-token trust or X-Task-ID/agent
 * cross-validation that depend on the agent_task subsystem not ported here. The
 * agent must exist in the request's workspace, otherwise we fall back to member.
 */
async function resolveActor(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  wsId: string,
): Promise<{ authorType: string; authorId: string }> {
  const agentId = c.req.header("X-Agent-ID");
  if (!agentId || !UUID_RE.test(agentId)) {
    return { authorType: "member", authorId: userId };
  }
  // An agent identity is only trusted when accompanied by a task context.
  if (!c.req.header("X-Task-ID")) {
    return { authorType: "member", authorId: userId };
  }
  const a = await getAgent(db, agentId);
  if (!a || a.workspaceId !== wsId) {
    return { authorType: "member", authorId: userId };
  }
  return { authorType: "agent", authorId: agentId };
}

export function commentRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    // roots_only: top-level comments + thread stats (the threaded list view).
    if (c.req.query("roots_only") === "true") {
      const roots = await listRootCommentsWithStats(db, issue.id, ws);
      return c.json(roots.map(rootCommentToResponse));
    }

    // since=<RFC3339>: only comments newer than the cursor (incremental polling).
    const sinceStr = c.req.query("since");
    if (sinceStr) {
      const since = new Date(sinceStr);
      if (Number.isNaN(since.getTime())) return c.json({ error: "invalid since parameter" }, 400);
      const fresh = await listCommentsForIssueSince(db, issue.id, ws, since);
      return c.json(fresh.map(commentToResponse));
    }

    const comments = await listCommentsForIssue(db, issue.id, ws);
    return c.json(comments.map(commentToResponse));
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const issue = await requireIssue(c, db, ws);
    if (issue instanceof Response) return issue;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const content = typeof body.content === "string" ? body.content : "";
    if (!content) return c.json({ error: "content is required" }, 400);
    const type = typeof body.type === "string" && body.type ? body.type : "comment";

    // parent_id: when present it must be a UUID AND reference a comment on the
    // same issue (mirrors Go: parse → load → compare issue id).
    let parentId: string | null = null;
    if (body.parent_id != null) {
      const raw = body.parent_id;
      if (typeof raw !== "string" || !UUID_RE.test(raw)) {
        return c.json({ error: "invalid parent_id" }, 400);
      }
      const parent = await getComment(db, raw);
      if (!parent || parent.issueId !== issue.id) {
        return c.json({ error: "invalid parent comment" }, 400);
      }
      parentId = raw;
    }

    const { authorType, authorId } = await resolveActor(c, db, c.get("user").sub, ws);

    const created = await createComment(db, {
      issueId: issue.id,
      workspaceId: ws,
      authorType,
      authorId,
      content,
      type,
      parentId,
    });

    bus.publish({ type: "comment.created", workspaceId: ws, payload: { id: created.id, issue_id: issue.id } });

    // Wake any @mentioned agents with a task carrying this comment as trigger.
    // Best-effort: a trigger failure must not fail the comment write.
    try {
      await enqueueMentionedAgentTasks(db, issue, created, authorType, authorId);
    } catch (err) {
      console.warn("comment: enqueue mentioned agent tasks failed:", err);
    }
    // A member comment also wakes the issue's agent assignee — no @ needed
    // (Go shouldEnqueueOnComment). Runs after the mention pass so its
    // pending-task dedup naturally absorbs a comment that @mentioned the
    // assignee.
    try {
      await enqueueAssigneeOnComment(db, issue, created, authorType, authorId);
    } catch (err) {
      console.warn("comment: enqueue assignee task failed:", err);
    }

    return c.json(commentToResponse(created), 201);
  });

  return r;
}
