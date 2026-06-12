/**
 * Assignment-driven task dispatch — the kanban's core trigger (port of the
 * Go UpdateIssue reconciliation block, issue.go ~2419-2461):
 *
 *   - assignee changed     → cancel the issue's active tasks; if the new
 *                            assignee is a ready agent and the issue is not
 *                            parked in backlog, enqueue a fresh task;
 *   - backlog → active     → (assignee unchanged) the parking-lot promotion:
 *                            enqueue for the ready agent assignee;
 *   - status → cancelled   → user-initiated terminal action: cancel tasks.
 *
 * Squad-leader dispatch and the agent self-loop exclusion are not ported yet
 * (no agent-actor identity reaches this API in the bun build).
 */

import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent as agentTbl, agentTaskQueue, issue as issueTbl, squad as squadTbl } from "../db/schema.js";
import { createAgentTask } from "../db/queries/miscActions.js";
import { bus } from "../realtime/bus.js";

type Issue = typeof issueTbl.$inferSelect;
type AgentTask = typeof agentTaskQueue.$inferSelect;

const ACTIVE_STATUSES = ["queued", "dispatched", "running", "waiting_local_directory"];

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

/** Cancel every active task on the issue (any agent). Returns cancelled rows. */
async function cancelActiveTasksByIssue(db: Db, issueId: string): Promise<AgentTask[]> {
  return db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(and(eq(agentTaskQueue.issueId, issueId), inArray(agentTaskQueue.status, ACTIVE_STATUSES)))
    .returning();
}

/** A dispatchable agent: exists in the workspace, not archived, has a runtime. */
export async function getReadyAgent(
  db: Db,
  wsId: string,
  agentId: string,
): Promise<{ agentId: string; runtimeId: string } | null> {
  const [ag] = await db
    .select()
    .from(agentTbl)
    .where(and(eq(agentTbl.id, agentId), eq(agentTbl.workspaceId, wsId)));
  if (!ag || ag.archivedAt || !ag.runtimeId) return null;
  return { agentId: ag.id, runtimeId: ag.runtimeId };
}

/** Resolve a squad to its (ready) leader agent. */
export async function getReadySquadLeader(
  db: Db,
  wsId: string,
  squadId: string,
): Promise<{ agentId: string; runtimeId: string } | null> {
  const [sq] = await db
    .select()
    .from(squadTbl)
    .where(and(eq(squadTbl.id, squadId), eq(squadTbl.workspaceId, wsId)));
  if (!sq || !sq.leaderId) return null;
  return getReadyAgent(db, wsId, sq.leaderId);
}

/** Go isAgentAssigneeReady: agent assignee exists, not archived, has a runtime. */
async function readyAgentAssignee(
  db: Db,
  iss: Issue,
): Promise<{ agentId: string; runtimeId: string } | null> {
  if (iss.assigneeType !== "agent" || !iss.assigneeId) return null;
  return getReadyAgent(db, iss.workspaceId, iss.assigneeId);
}

export async function enqueueForIssue(
  db: Db,
  wsId: string,
  iss: Issue,
  ready: { agentId: string; runtimeId: string },
): Promise<AgentTask> {
  const task = await createAgentTask(db, {
    agentId: ready.agentId,
    runtimeId: ready.runtimeId,
    issueId: iss.id,
    status: "queued",
    priority: priorityToInt(iss.priority),
    attempt: 1,
    maxAttempts: 2,
  });
  publishTaskEvent("task:queued", wsId, task);
  return task;
}

/**
 * Enqueue a task for an issue's ready agent assignee, returning the task (or
 * null when the assignee isn't a dispatchable agent). Quick-create uses this
 * to hand the task id back to the caller.
 */
export async function enqueueIssueTask(db: Db, wsId: string, iss: Issue): Promise<AgentTask | null> {
  const ready = await readyAgentAssignee(db, iss);
  if (!ready) return null;
  return enqueueForIssue(db, wsId, iss, ready);
}

/**
 * Dispatch on create: an issue born with a ready agent assignee outside the
 * backlog parking lot starts work immediately (Go CreateIssue parity).
 */
export async function dispatchOnCreate(db: Db, wsId: string, created: Issue): Promise<void> {
  if (created.status === "backlog") return;
  const ready = await readyAgentAssignee(db, created);
  if (ready) await enqueueForIssue(db, wsId, created, ready);
}

/**
 * Reconcile the task queue after an issue update. Best-effort: callers must
 * not fail the issue write over a dispatch problem.
 */
export async function reconcileTasksOnIssueUpdate(
  db: Db,
  wsId: string,
  prev: Issue,
  updated: Issue,
): Promise<void> {
  const assigneeChanged =
    prev.assigneeType !== updated.assigneeType || prev.assigneeId !== updated.assigneeId;
  const statusChanged = prev.status !== updated.status;

  if (assigneeChanged) {
    const cancelled = await cancelActiveTasksByIssue(db, updated.id);
    for (const t of cancelled) publishTaskEvent("task:cancelled", wsId, t);

    if (updated.status !== "backlog") {
      const ready = await readyAgentAssignee(db, updated);
      if (ready) await enqueueForIssue(db, wsId, updated, ready);
    }
    return;
  }

  if (statusChanged && updated.status === "cancelled") {
    const cancelled = await cancelActiveTasksByIssue(db, updated.id);
    for (const t of cancelled) publishTaskEvent("task:cancelled", wsId, t);
    return;
  }

  // Backlog is a parking lot: promoting out of it signals "ready for work".
  if (
    statusChanged &&
    prev.status === "backlog" &&
    updated.status !== "done" &&
    updated.status !== "cancelled"
  ) {
    const ready = await readyAgentAssignee(db, updated);
    if (ready) await enqueueForIssue(db, wsId, updated, ready);
  }
}
