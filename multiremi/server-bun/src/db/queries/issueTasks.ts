/**
 * Issue-scoped task queries — port of the Go issue-detail task reads
 * (server/internal/handler/daemon.go: GetActiveTaskForIssue / ListTasksByIssue /
 * GetIssueUsage / CancelTask) plus the timeline enrichment batch reads
 * (reaction.go groupReactions / file.go groupAttachments).
 *
 * The issue is resolved + authorized to the workspace by the caller (the route
 * gate), so these helpers never re-check tenancy themselves — except the
 * attachment batch read, which keeps the Go query's workspace_id filter as
 * defense-in-depth (ListAttachmentsByCommentIDs).
 */

import { and, desc, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentTaskQueue, attachment, commentReaction, taskUsage } from "../schema.js";

export type AgentTask = typeof agentTaskQueue.$inferSelect;
export type CommentReaction = typeof commentReaction.$inferSelect;
export type Attachment = typeof attachment.$inferSelect;

/**
 * Non-terminal queue states. Includes 'queued' so the issue-detail "agent live"
 * banner shows up the moment a task is enqueued — not only after a runtime
 * claims it (mirrors the Go ListActiveTasksByIssue comment).
 */
export const ACTIVE_TASK_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "waiting_local_directory",
] as const;

/** All currently-active tasks for an issue, newest first (Go ListActiveTasksByIssue). */
export async function listActiveTasksByIssue(db: Db, issueId: string): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.issueId, issueId),
        inArray(agentTaskQueue.status, [...ACTIVE_TASK_STATUSES]),
      ),
    )
    .orderBy(desc(agentTaskQueue.createdAt));
}

/** All tasks (any status) for an issue, newest first (Go ListTasksByIssue). */
export async function listTasksByIssue(db: Db, issueId: string): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTaskQueue)
    .where(eq(agentTaskQueue.issueId, issueId))
    .orderBy(desc(agentTaskQueue.createdAt));
}

/**
 * Cancel a task if it is still in an active state (Go CancelAgentTask). Returns
 * the updated row, or null when nothing matched — i.e. the task is already
 * terminal, which the caller treats as an idempotent success (re-read + return
 * the current row, no event).
 */
export async function cancelAgentTask(db: Db, id: string): Promise<AgentTask | null> {
  const [t] = await db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(
      and(eq(agentTaskQueue.id, id), inArray(agentTaskQueue.status, [...ACTIVE_TASK_STATUSES])),
    )
    .returning();
  return t ?? null;
}

export interface IssueUsageSummaryRow {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  taskCount: number;
}

/**
 * Aggregated token usage over every task belonging to an issue (Go
 * GetIssueUsageSummary): task_usage JOIN agent_task_queue ON task_id, filtered
 * by issue_id. The bigint sums come back from postgres-js as strings — callers
 * wrap with Number() at the serialization boundary (same as runtimeUsage.ts).
 */
export async function getIssueUsageSummary(db: Db, issueId: string): Promise<IssueUsageSummaryRow> {
  const [row] = await db
    .select({
      totalInputTokens: sql<number>`coalesce(sum(${taskUsage.inputTokens}), 0)::bigint`,
      totalOutputTokens: sql<number>`coalesce(sum(${taskUsage.outputTokens}), 0)::bigint`,
      totalCacheReadTokens: sql<number>`coalesce(sum(${taskUsage.cacheReadTokens}), 0)::bigint`,
      totalCacheWriteTokens: sql<number>`coalesce(sum(${taskUsage.cacheWriteTokens}), 0)::bigint`,
      taskCount: sql<number>`count(distinct ${taskUsage.taskId})::int`,
    })
    .from(taskUsage)
    .innerJoin(agentTaskQueue, eq(agentTaskQueue.id, taskUsage.taskId))
    .where(eq(agentTaskQueue.issueId, issueId));
  return (
    row ?? {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      taskCount: 0,
    }
  );
}

/** Batch read: reactions for a set of comments (Go ListReactionsByCommentIDs). */
export async function listReactionsByCommentIds(
  db: Db,
  commentIds: string[],
): Promise<CommentReaction[]> {
  if (commentIds.length === 0) return [];
  return db
    .select()
    .from(commentReaction)
    .where(inArray(commentReaction.commentId, commentIds))
    .orderBy(asc(commentReaction.createdAt));
}

/** Batch read: attachments for a set of comments (Go ListAttachmentsByCommentIDs). */
export async function listAttachmentsByCommentIds(
  db: Db,
  commentIds: string[],
  wsId: string,
): Promise<Attachment[]> {
  if (commentIds.length === 0) return [];
  return db
    .select()
    .from(attachment)
    .where(and(inArray(attachment.commentId, commentIds), eq(attachment.workspaceId, wsId)))
    .orderBy(asc(attachment.createdAt));
}
