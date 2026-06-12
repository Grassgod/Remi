/**
 * Comment action queries — port of the Go write path for a single comment
 * (server/pkg/db/queries/comment.sql, reaction.sql, attachment.sql, agent.sql):
 * GetCommentInWorkspace, UpdateComment, DeleteComment, ResolveComment,
 * UnresolveComment, AddReaction, RemoveReaction, ReplaceCommentAttachments and
 * CancelAgentTasksByTriggerComment.
 *
 * Read-side helpers these routes also need (membership gate, reaction /
 * attachment grouping) already exist in comments.ts / issueTasks.ts and are
 * imported by the route, not duplicated here.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentTaskQueue, attachment, comment, commentReaction } from "../schema.js";
import type { Comment } from "../schema.js";

/** Reaction row type (same table the issueTasks read path selects from). */
export type CommentReaction = typeof commentReaction.$inferSelect;
/** Agent task row type (returned by the cancel-by-trigger sweep). */
export type AgentTask = typeof agentTaskQueue.$inferSelect;

/** Go GetCommentInWorkspace: WHERE id = $1 AND workspace_id = $2 (tenant scope). */
export async function getCommentInWorkspace(db: Db, id: string, wsId: string): Promise<Comment | null> {
  const [c] = await db
    .select()
    .from(comment)
    .where(and(eq(comment.id, id), eq(comment.workspaceId, wsId)));
  return c ?? null;
}

/** Go UpdateComment: SET content = $2, updated_at = now() ... RETURNING *. */
export async function updateCommentContent(db: Db, id: string, content: string): Promise<Comment | null> {
  const [c] = await db
    .update(comment)
    .set({ content, updatedAt: sql`now()` })
    .where(eq(comment.id, id))
    .returning();
  return c ?? null;
}

/**
 * Go DeleteComment. workspace_id is a SQL-layer tenant guard (defense in
 * depth, see the Go query's comment). Returns whether a row was deleted.
 */
export async function deleteCommentInWorkspace(db: Db, id: string, wsId: string): Promise<boolean> {
  const rows = await db
    .delete(comment)
    .where(and(eq(comment.id, id), eq(comment.workspaceId, wsId)))
    .returning({ id: comment.id });
  return rows.length > 0;
}

/**
 * Go ResolveComment — idempotent: re-resolving keeps the original resolved_at
 * + resolver (COALESCE), and updated_at only moves on the first resolve.
 * Always returns the row so the handler can surface the canonical state.
 */
export async function resolveComment(
  db: Db,
  id: string,
  resolvedByType: string,
  resolvedById: string,
): Promise<Comment | null> {
  const [c] = await db
    .update(comment)
    .set({
      resolvedAt: sql`COALESCE(${comment.resolvedAt}, now())`,
      resolvedByType: sql`COALESCE(${comment.resolvedByType}, ${resolvedByType})`,
      resolvedById: sql`COALESCE(${comment.resolvedById}, ${resolvedById}::uuid)`,
      updatedAt: sql`CASE WHEN ${comment.resolvedAt} IS NULL THEN now() ELSE ${comment.updatedAt} END`,
    })
    .where(eq(comment.id, id))
    .returning();
  return c ?? null;
}

/** Go UnresolveComment — idempotent: a no-op clear just returns the row. */
export async function unresolveComment(db: Db, id: string): Promise<Comment | null> {
  const [c] = await db
    .update(comment)
    .set({
      resolvedAt: null,
      resolvedByType: null,
      resolvedById: null,
      updatedAt: sql`CASE WHEN ${comment.resolvedAt} IS NOT NULL THEN now() ELSE ${comment.updatedAt} END`,
    })
    .where(eq(comment.id, id))
    .returning();
  return c ?? null;
}

/**
 * Go AddReaction: INSERT ... ON CONFLICT (comment_id, actor_type, actor_id,
 * emoji) DO UPDATE SET created_at = comment_reaction.created_at RETURNING * —
 * a no-op upsert so a duplicate react returns the existing row instead of
 * erroring.
 */
export async function addReaction(
  db: Db,
  input: { commentId: string; workspaceId: string; actorType: string; actorId: string; emoji: string },
): Promise<CommentReaction> {
  const [r] = await db
    .insert(commentReaction)
    .values(input)
    .onConflictDoUpdate({
      target: [commentReaction.commentId, commentReaction.actorType, commentReaction.actorId, commentReaction.emoji],
      set: { createdAt: sql`${commentReaction.createdAt}` },
    })
    .returning();
  return r!;
}

/** Go RemoveReaction: delete one actor's emoji from a comment. */
export async function removeReaction(
  db: Db,
  commentId: string,
  actorType: string,
  actorId: string,
  emoji: string,
): Promise<void> {
  await db
    .delete(commentReaction)
    .where(
      and(
        eq(commentReaction.commentId, commentId),
        eq(commentReaction.actorType, actorType),
        eq(commentReaction.actorId, actorId),
        eq(commentReaction.emoji, emoji),
      ),
    );
}

/**
 * Go ReplaceCommentAttachments — single statement that makes `attachmentIds`
 * the comment's exact attachment set: rows in the list become linked, rows
 * currently linked but absent from the list are unlinked (comment_id = NULL,
 * never cross-issue). An empty list unlinks everything.
 */
export async function replaceCommentAttachments(
  db: Db,
  commentId: string,
  issueId: string,
  attachmentIds: string[],
): Promise<void> {
  await db
    .update(attachment)
    .set({
      commentId: sql`CASE WHEN ${inArray(attachment.id, attachmentIds)} THEN ${commentId}::uuid ELSE NULL END`,
    })
    .where(
      and(
        eq(attachment.issueId, issueId),
        or(
          eq(attachment.commentId, commentId),
          and(isNull(attachment.commentId), inArray(attachment.id, attachmentIds)),
        ),
      ),
    );
}

/**
 * Go CancelAgentTasksByTriggerComment: cancel active tasks whose trigger is
 * the given comment, so an agent does not run with deleted/edited content
 * already embedded in its prompt. Must run BEFORE the comment row is deleted
 * (the FK ON DELETE SET NULL would otherwise nullify trigger_comment_id).
 * Returns the cancelled rows so the caller can broadcast task:cancelled.
 */
export async function cancelTasksByTriggerComment(db: Db, commentId: string): Promise<AgentTask[]> {
  return db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(
      and(
        eq(agentTaskQueue.triggerCommentId, commentId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running", "waiting_local_directory"]),
      ),
    )
    .returning();
}
