/**
 * Query helpers for the misc single-resource action routes (miscActions.ts):
 * label update/delete, inbox archive, attachment delete, task transcript,
 * user-facing task cancel, and the manual issue rerun. Each mirrors a named
 * sqlc query from server/pkg/db/queries/ (noted per function).
 *
 * Reads that already exist elsewhere are NOT duplicated here — the route file
 * imports getLabel (labels.ts), getInboxItemInWorkspace (inbox.ts),
 * getAttachment (attachments.ts), getAgentTask (daemontasks.ts),
 * cancelAgentTask (issueTasks.ts), getIssueByIdentifier / getMembership
 * (issues.ts), getAgentInWorkspace (agents.ts), getSquadInWorkspace
 * (squads.ts) and getChatSessionInWorkspace (chat.ts) directly.
 */

import { and, asc, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  agent,
  agentTaskQueue,
  attachment,
  autopilot,
  autopilotRun,
  chatSession,
  inboxItem,
  issue,
  issueLabel,
  taskMessage,
} from "../schema.js";

export type Label = typeof issueLabel.$inferSelect;
export type InboxItem = typeof inboxItem.$inferSelect;
export type TaskMessage = typeof taskMessage.$inferSelect;
export type AgentTask = typeof agentTaskQueue.$inferSelect;
export type NewAgentTask = typeof agentTaskQueue.$inferInsert;

/**
 * Active (non-terminal) queue states — keep in sync with
 * issueTasks.ts ACTIVE_TASK_STATUSES (not exported as a shared constant there
 * for value use without import cycles; the literal list mirrors the Go SQL).
 */
const ACTIVE_STATUSES = ["queued", "dispatched", "running", "waiting_local_directory"];

/**
 * Partial-update a label inside a workspace (Go UpdateLabel: COALESCE on name
 * and color, updated_at = now(), WHERE id AND workspace_id RETURNING *).
 * null = no row matched → the caller 404s. Caller validates/normalizes the
 * patch values first.
 */
export async function updateLabel(
  db: Db,
  wsId: string,
  id: string,
  patch: { name?: string; color?: string },
): Promise<Label | null> {
  const [l] = await db
    .update(issueLabel)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issueLabel.id, id), eq(issueLabel.workspaceId, wsId)))
    .returning();
  return l ?? null;
}

/**
 * Delete a label inside a workspace (Go DeleteLabel: RETURNING id so a missing
 * row → 404 instead of a silent 204 — the #1661 class of bug).
 */
export async function deleteLabel(db: Db, wsId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(issueLabel)
    .where(and(eq(issueLabel.id, id), eq(issueLabel.workspaceId, wsId)))
    .returning({ id: issueLabel.id });
  return rows.length > 0;
}

/** Archive a single inbox item (Go ArchiveInboxItem: RETURNING *). */
export async function archiveInboxItem(db: Db, id: string): Promise<InboxItem> {
  const [i] = await db
    .update(inboxItem)
    .set({ archived: true })
    .where(eq(inboxItem.id, id))
    .returning();
  return i!;
}

/**
 * Archive all sibling inbox items of the same recipient for one issue —
 * the issue-level archive sweep that follows a single-item archive
 * (Go ArchiveInboxByIssue).
 */
export async function archiveInboxByIssue(
  db: Db,
  params: { workspaceId: string; recipientType: string; recipientId: string; issueId: string },
): Promise<void> {
  await db
    .update(inboxItem)
    .set({ archived: true })
    .where(
      and(
        eq(inboxItem.workspaceId, params.workspaceId),
        eq(inboxItem.recipientType, params.recipientType),
        eq(inboxItem.recipientId, params.recipientId),
        eq(inboxItem.issueId, params.issueId),
        eq(inboxItem.archived, false),
      ),
    );
}

/** Delete an attachment row inside a workspace (Go DeleteAttachment). */
export async function deleteAttachmentRow(db: Db, wsId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(attachment)
    .where(and(eq(attachment.id, id), eq(attachment.workspaceId, wsId)))
    .returning({ id: attachment.id });
  return rows.length > 0;
}

/**
 * The transcript of a task, ordered by seq ASC. With `sinceSeq` only rows with
 * seq > sinceSeq are returned (Go ListTaskMessages / ListTaskMessagesSince).
 */
export async function listTaskMessages(
  db: Db,
  taskId: string,
  sinceSeq?: number,
): Promise<TaskMessage[]> {
  return db
    .select()
    .from(taskMessage)
    .where(
      sinceSeq === undefined
        ? eq(taskMessage.taskId, taskId)
        : and(eq(taskMessage.taskId, taskId), gt(taskMessage.seq, sinceSeq)),
    )
    .orderBy(asc(taskMessage.seq));
}

/**
 * Load a task only when its owning agent lives in the given workspace
 * (Go GetAgentTaskInWorkspace). agent_id is NOT NULL on every task row, which
 * makes this the universal tenant guard for user-initiated cancellation —
 * independent of which optional source FK (issue/chat_session/autopilot_run)
 * is set.
 */
export async function getAgentTaskInWorkspace(
  db: Db,
  wsId: string,
  taskId: string,
): Promise<AgentTask | null> {
  const [t] = await db
    .select(getTableColumns(agentTaskQueue))
    .from(agentTaskQueue)
    .innerJoin(agent, eq(agent.id, agentTaskQueue.agentId))
    .where(and(eq(agentTaskQueue.id, taskId), eq(agent.workspaceId, wsId)));
  return t ?? null;
}

/**
 * Cancel the active tasks of a single (issue, agent) pair without touching
 * tasks belonging to other agents on the same issue (Go
 * CancelAgentTasksByIssueAndAgent). Returns the affected rows so the caller
 * can broadcast task:cancelled events. Also what keeps the
 * idx_one_pending_task_per_issue_agent partial-unique index satisfied before
 * the rerun inserts its fresh queued row.
 */
export async function cancelAgentTasksByIssueAndAgent(
  db: Db,
  issueId: string,
  agentId: string,
): Promise<AgentTask[]> {
  return db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(
      and(
        eq(agentTaskQueue.issueId, issueId),
        eq(agentTaskQueue.agentId, agentId),
        inArray(agentTaskQueue.status, ACTIVE_STATUSES),
      ),
    )
    .returning();
}

/** Insert a fresh queued task (Go CreateAgentTask, used by the rerun flow). */
export async function createAgentTask(db: Db, input: NewAgentTask): Promise<AgentTask> {
  const [t] = await db.insert(agentTaskQueue).values(input).returning();
  return t!;
}

/**
 * Determine the workspace a task belongs to (Go ResolveTaskWorkspaceID):
 * issue → chat session → autopilot run → quick-create context JSONB. null when
 * none of the links resolve — callers treat that as "not found".
 */
export async function resolveTaskWorkspaceId(db: Db, task: AgentTask): Promise<string | null> {
  if (task.issueId) {
    const [i] = await db
      .select({ workspaceId: issue.workspaceId })
      .from(issue)
      .where(eq(issue.id, task.issueId));
    if (i) return i.workspaceId;
  }
  if (task.chatSessionId) {
    const [cs] = await db
      .select({ workspaceId: chatSession.workspaceId })
      .from(chatSession)
      .where(eq(chatSession.id, task.chatSessionId));
    if (cs) return cs.workspaceId;
  }
  if (task.autopilotRunId) {
    const [row] = await db
      .select({ workspaceId: autopilot.workspaceId })
      .from(autopilotRun)
      .innerJoin(autopilot, eq(autopilot.id, autopilotRun.autopilotId))
      .where(eq(autopilotRun.id, task.autopilotRunId));
    if (row) return row.workspaceId;
  }
  // Quick-create tasks have no issue / chat / autopilot link — the workspace
  // lives in the context JSONB ({ type: "quick_create", workspace_id }).
  const ctx = task.context;
  if (typeof ctx === "object" && ctx !== null && !Array.isArray(ctx)) {
    const o = ctx as { type?: unknown; workspace_id?: unknown };
    if (o.type === "quick_create" && typeof o.workspace_id === "string" && o.workspace_id) {
      return o.workspace_id;
    }
  }
  return null;
}
