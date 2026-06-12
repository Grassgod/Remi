/**
 * Comment action routes (write path on a single comment) — port of the Go
 * handlers registered under /api/comments/{commentId} (cmd/server/router.go):
 *
 *   PUT    /api/comments/:commentId           → UpdateComment   (comment.go)
 *   DELETE /api/comments/:commentId           → DeleteComment   (comment.go)
 *   POST   /api/comments/:commentId/reactions → AddReaction     (reaction.go)
 *   DELETE /api/comments/:commentId/reactions → RemoveReaction  (reaction.go)
 *   POST   /api/comments/:commentId/resolve   → ResolveComment  (comment.go)
 *   DELETE /api/comments/:commentId/resolve   → UnresolveComment(comment.go)
 *
 * Declared on absolute paths in a standalone factory (same shape as
 * issueTasksRoutes) so it composes without editing other route files. Behind
 * the /api/* JWT gate; scoped to a workspace via X-Workspace-ID + a membership
 * check (the Go RequireWorkspaceMember middleware). The comment is always
 * loaded workspace-scoped (Go GetCommentInWorkspace), so cross-workspace
 * probes 404. Edit/delete are author-or-admin only; reactions and
 * resolve/unresolve are open to any workspace member, exactly like Go.
 *
 * Not ported (consistent with the rest of the Bun rewrite): the
 * ExpandIssueIdentifiers mention pipeline (the create path doesn't run it
 * either) and S3 blob cleanup on delete (the DB CASCADE removes attachment
 * rows; blob storage is the attachments route's concern).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Comment, Member } from "../../db/schema.js";
import { getAgent, getMembership } from "../../db/queries/comments.js";
import { getIssueByIdentifier } from "../../db/queries/issues.js";
import {
  listAttachmentsByCommentIds,
  listReactionsByCommentIds,
  type Attachment,
} from "../../db/queries/issueTasks.js";
import {
  addReaction,
  cancelTasksByTriggerComment,
  deleteCommentInWorkspace,
  getCommentInWorkspace,
  removeReaction,
  replaceCommentAttachments,
  resolveComment,
  unresolveComment,
  updateCommentContent,
  type AgentTask,
  type CommentReaction,
} from "../../db/queries/commentActions.js";
import { enqueueMentionedAgentTasks } from "../../agent/commentTrigger.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go ReactionResponse struct (snake_case JSON). */
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

/** The metadata-only download path (matches Go attachmentDownloadPath). */
function attachmentDownloadPath(id: string): string {
  return `/api/attachments/${id}/download`;
}

/** Mirrors the Go AttachmentResponse struct (snake_case JSON, no CF signer). */
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
    download_url: attachmentDownloadPath(a.id),
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt,
  };
}

/** Go CommentResponse with the reactions + attachments arrays populated. */
function commentToResponse(c: Comment, reactions: CommentReaction[], attachments: Attachment[]) {
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
    reactions: reactions.map(reactionToResponse),
    attachments: attachments.map(attachmentToResponse),
  };
}

/** Fetch reactions + attachments for one comment and build the full response. */
async function commentResponseFor(db: Db, wsId: string, c: Comment) {
  const reactions = await listReactionsByCommentIds(db, [c.id]);
  const attachments = await listAttachmentsByCommentIds(db, [c.id], wsId);
  return commentToResponse(c, reactions, attachments);
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID and the caller's member row, or a Response to short-circuit
 * with (400 missing/malformed header, 404 not-a-member — mirrors the Go
 * RequireWorkspaceMember middleware these routes sit behind).
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
 * Load the :commentId path param scoped to the workspace (Go
 * GetCommentInWorkspace after parseUUIDOrBadRequest). 400 on a malformed id,
 * 404 when absent or in another workspace.
 */
async function requireComment(c: Context<AppEnv>, db: Db, wsId: string): Promise<Comment | Response> {
  const id = c.req.param("commentId") ?? "";
  if (!UUID_RE.test(id)) return c.json({ error: "invalid comment id" }, 400);
  const found = await getCommentInWorkspace(db, id, wsId);
  if (!found) return c.json({ error: "comment not found" }, 404);
  return found;
}

/**
 * Determine the actor identity: agent (via X-Agent-ID, validated against the
 * workspace and a present X-Task-ID) or member. Mirrors Go resolveActor's
 * subset used across the Bun routes — without task-token trust or the
 * X-Task-ID/agent cross-validation that depend on the agent_task subsystem.
 */
async function resolveActor(
  c: Context<AppEnv>,
  db: Db,
  wsId: string,
): Promise<{ actorType: string; actorId: string }> {
  const userId = c.get("user").sub;
  const agentId = c.req.header("X-Agent-ID");
  if (!agentId || !UUID_RE.test(agentId)) {
    return { actorType: "member", actorId: userId };
  }
  // An agent identity is only trusted when accompanied by a task context.
  if (!c.req.header("X-Task-ID")) {
    return { actorType: "member", actorId: userId };
  }
  const a = await getAgent(db, agentId);
  if (!a || a.workspaceId !== wsId) {
    return { actorType: "member", actorId: userId };
  }
  return { actorType: "agent", actorId: agentId };
}

/** Parse the request body and pull a non-empty `emoji` (Go reaction handlers). */
async function readEmoji(c: Context<AppEnv>): Promise<{ emoji: string } | Response> {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid request body" }, 400);
  }
  const emoji = typeof body.emoji === "string" ? body.emoji : "";
  if (!emoji) return c.json({ error: "emoji is required" }, 400);
  return { emoji };
}

/**
 * Author-or-admin gate shared by edit/delete (Go: isAuthor || roleAllowed
 * (owner, admin)).
 */
function canModerate(existing: Comment, actorType: string, actorId: string, role: string): boolean {
  const isAuthor = existing.authorType === actorType && existing.authorId === actorId;
  const isAdmin = role === "owner" || role === "admin";
  return isAuthor || isAdmin;
}

/**
 * Cancel active tasks triggered by this comment and broadcast task:cancelled
 * for each (Go TaskService.CancelTasksByTriggerComment). Best-effort: a
 * failure must not fail the comment write that invoked it.
 */
async function cancelTriggeredTasks(db: Db, wsId: string, commentId: string): Promise<void> {
  let cancelled: AgentTask[] = [];
  try {
    cancelled = await cancelTasksByTriggerComment(db, commentId);
  } catch (err) {
    console.warn("comment: cancel tasks by trigger comment failed:", err);
    return;
  }
  for (const t of cancelled) {
    const payload: Record<string, unknown> = {
      task_id: t.id,
      agent_id: t.agentId,
      issue_id: t.issueId ?? "",
      status: t.status,
    };
    if (t.chatSessionId) payload.chat_session_id = t.chatSessionId;
    bus.publish({ type: "task:cancelled", workspaceId: wsId, payload });
  }
}

export function commentActionsRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // PUT /api/comments/:commentId — edit the body (and optionally replace the
  // attachment set). Author or workspace owner/admin only (Go UpdateComment).
  r.put("/api/comments/:commentId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId, member } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;

    const { actorType, actorId } = await resolveActor(c, db, wsId);
    if (!canModerate(existing, actorType, actorId, member.role)) {
      return c.json({ error: "only comment author or admin can edit" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const content = typeof body.content === "string" ? body.content : "";
    if (!content) return c.json({ error: "content is required" }, 400);

    // attachment_ids: absent / null → preserve the existing links (older
    // clients omit the field); present → replace the set, [] unlinks all
    // (Go's *[]string nil-vs-empty distinction).
    let attachmentIds: string[] | null = null;
    const rawIds = body.attachment_ids;
    if (rawIds !== undefined && rawIds !== null) {
      if (!Array.isArray(rawIds) || rawIds.some((v) => typeof v !== "string")) {
        return c.json({ error: "invalid request body" }, 400);
      }
      if ((rawIds as string[]).some((v) => !UUID_RE.test(v))) {
        return c.json({ error: "invalid attachment_ids" }, 400);
      }
      attachmentIds = rawIds as string[];
    }

    const oldContent = existing.content;
    const updated = await updateCommentContent(db, existing.id, content);
    if (!updated) return c.json({ error: "failed to update comment" }, 500);

    if (attachmentIds !== null) {
      await replaceCommentAttachments(db, existing.id, existing.issueId, attachmentIds);
    }

    const resp = await commentResponseFor(db, wsId, updated);
    bus.publish({ type: "comment:updated", workspaceId: wsId, payload: { comment: resp } });

    // The edit may add/remove @mentions: cancel tasks whose prompt embeds the
    // stale content, then re-parse and wake the (re-)mentioned agents — same
    // post-processing as Go (CancelTasksByTriggerComment + triggerTasksForComment).
    if (oldContent !== updated.content) {
      await cancelTriggeredTasks(db, wsId, existing.id);
      const issue = await getIssueByIdentifier(db, wsId, existing.issueId);
      if (issue) {
        try {
          await enqueueMentionedAgentTasks(db, issue, updated, actorType, actorId);
        } catch (err) {
          console.warn("comment: enqueue mentioned agent tasks failed:", err);
        }
      }
    }

    return c.json(resp);
  });

  // DELETE /api/comments/:commentId — author or workspace owner/admin only
  // (Go DeleteComment).
  r.delete("/api/comments/:commentId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId, member } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;

    const { actorType, actorId } = await resolveActor(c, db, wsId);
    if (!canModerate(existing, actorType, actorId, member.role)) {
      return c.json({ error: "only comment author or admin can delete" }, 403);
    }

    // Cancel any active tasks triggered by this comment BEFORE the delete —
    // the FK ON DELETE SET NULL would otherwise nullify trigger_comment_id
    // and orphan those tasks in queued (Go DeleteComment ordering).
    await cancelTriggeredTasks(db, wsId, existing.id);

    const ok = await deleteCommentInWorkspace(db, existing.id, existing.workspaceId);
    if (!ok) return c.json({ error: "failed to delete comment" }, 500);

    bus.publish({
      type: "comment:deleted",
      workspaceId: wsId,
      payload: { comment_id: existing.id, issue_id: existing.issueId },
    });
    return c.body(null, 204);
  });

  // POST /api/comments/:commentId/reactions — any workspace member / agent
  // (Go AddReaction). Upsert: duplicate reacts return the existing row.
  r.post("/api/comments/:commentId/reactions", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;

    const parsed = await readEmoji(c);
    if (parsed instanceof Response) return parsed;

    const { actorType, actorId } = await resolveActor(c, db, wsId);
    const reaction = await addReaction(db, {
      commentId: existing.id,
      workspaceId: wsId,
      actorType,
      actorId,
      emoji: parsed.emoji,
    });
    const resp = reactionToResponse(reaction);

    // Issue title/status ride along for inbox notifications (Go AddReaction).
    const issue = await getIssueByIdentifier(db, wsId, existing.issueId);
    bus.publish({
      type: "reaction:added",
      workspaceId: wsId,
      payload: {
        reaction: resp,
        issue_id: existing.issueId,
        issue_title: issue?.title ?? "",
        issue_status: issue?.status ?? "",
        comment_id: existing.id,
        comment_author_type: existing.authorType,
        comment_author_id: existing.authorId,
      },
    });
    return c.json(resp, 201);
  });

  // DELETE /api/comments/:commentId/reactions — remove the caller's own
  // reaction (Go RemoveReaction; the actor is part of the delete key).
  r.delete("/api/comments/:commentId/reactions", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;

    const parsed = await readEmoji(c);
    if (parsed instanceof Response) return parsed;

    const { actorType, actorId } = await resolveActor(c, db, wsId);
    await removeReaction(db, existing.id, actorType, actorId, parsed.emoji);

    bus.publish({
      type: "reaction:removed",
      workspaceId: wsId,
      payload: {
        comment_id: existing.id,
        issue_id: existing.issueId,
        emoji: parsed.emoji,
        actor_type: actorType,
        actor_id: actorId,
      },
    });
    return c.body(null, 204);
  });

  // POST /api/comments/:commentId/resolve — root comments only; any member
  // (Go ResolveComment via loadRootCommentForActor). Idempotent: a re-resolve
  // keeps the original resolver and suppresses the event.
  r.post("/api/comments/:commentId/resolve", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;
    if (existing.parentId) {
      return c.json({ error: "only root comments can be resolved" }, 400);
    }

    const { actorType, actorId } = await resolveActor(c, db, wsId);
    if (!UUID_RE.test(actorId)) return c.json({ error: "invalid actor id" }, 400);

    const wasResolved = existing.resolvedAt != null;
    const updated = await resolveComment(db, existing.id, actorType, actorId);
    if (!updated) return c.json({ error: "failed to resolve comment" }, 500);

    const resp = await commentResponseFor(db, wsId, updated);
    // Suppress the event on a re-resolve no-op so consumers do not re-process
    // an unchanged thread (notifications, log spam).
    if (!wasResolved) {
      bus.publish({ type: "comment:resolved", workspaceId: wsId, payload: { comment: resp } });
    }
    return c.json(resp);
  });

  // DELETE /api/comments/:commentId/resolve — reopen a resolved root comment
  // (Go UnresolveComment). Idempotent; the event fires only on a real clear.
  r.delete("/api/comments/:commentId/resolve", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const { wsId } = gate;
    const existing = await requireComment(c, db, wsId);
    if (existing instanceof Response) return existing;
    if (existing.parentId) {
      return c.json({ error: "only root comments can be resolved" }, 400);
    }

    const wasResolved = existing.resolvedAt != null;
    const updated = await unresolveComment(db, existing.id);
    if (!updated) return c.json({ error: "failed to unresolve comment" }, 500);

    const resp = await commentResponseFor(db, wsId, updated);
    if (wasResolved) {
      bus.publish({ type: "comment:unresolved", workspaceId: wsId, payload: { comment: resp } });
    }
    return c.json(resp);
  });

  return r;
}
