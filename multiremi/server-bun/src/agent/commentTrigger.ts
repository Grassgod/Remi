/**
 * Comment-triggered agent tasks — the "agents participate in conversations"
 * core (port of Go comment.go enqueueMentionedAgentTasks). When a comment
 * @mentions an agent, that agent is woken with a queued task carrying the
 * trigger comment id, so the daemon runs it and the agent can reply.
 *
 * This port covers the agent-mention path: load the agent in the issue's
 * workspace (must be unarchived), skip an agent mentioning itself, dedup against
 * an already-pending task, and enqueue. Not yet ported (follow-up): @squad →
 * leader routing, the private-agent access gate, and parent-comment mention
 * inheritance.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent as agentTbl, agentTaskQueue, member } from "../db/schema.js";
import type { Agent, Comment, Issue } from "../db/schema.js";
import { parseMentions } from "./mentions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `actor` may trigger `ag` via a mention (port of Go
 * canAccessPrivateAgent). Workspace-visible agents are open; private agents are
 * reachable only by another agent, their owner, or a workspace owner/admin.
 */
async function canAccessPrivateAgent(db: Db, ag: Agent, actorType: string, actorId: string): Promise<boolean> {
  if (ag.visibility !== "private") return true;
  if (actorType === "agent") return true;
  if (ag.ownerId === actorId) return true;
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, actorId), eq(member.workspaceId, ag.workspaceId)));
  return m?.role === "owner" || m?.role === "admin";
}

/**
 * Enqueue tasks for every agent @mentioned in `comment`. Returns the created
 * task ids (empty when nothing was triggered). Best-effort: a failure on one
 * mention does not stop the others.
 */
export async function enqueueMentionedAgentTasks(
  db: Db,
  issue: Issue,
  comment: Comment,
  authorType: string,
  authorId: string,
): Promise<string[]> {
  const enqueued: string[] = [];
  for (const m of parseMentions(comment.content)) {
    if (m.type !== "agent" || !UUID_RE.test(m.id)) continue;
    // An agent posting a comment shouldn't wake itself.
    if (authorType === "agent" && authorId === m.id) continue;

    // Resolve the agent scoped to THIS issue's workspace (never cross-tenant).
    const [ag] = await db
      .select()
      .from(agentTbl)
      .where(and(eq(agentTbl.id, m.id), eq(agentTbl.workspaceId, issue.workspaceId)));
    if (!ag || ag.archivedAt) continue;

    // Private-agent gate: a member can only wake a private agent they own or
    // administer; agent→agent always passes.
    if (!(await canAccessPrivateAgent(db, ag, authorType, authorId))) continue;

    // Dedup: skip if the agent already has a queued/dispatched task here.
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentTaskQueue)
      .where(
        and(
          eq(agentTaskQueue.issueId, issue.id),
          eq(agentTaskQueue.agentId, ag.id),
          inArray(agentTaskQueue.status, ["queued", "dispatched"]),
        ),
      );
    if ((pending?.n ?? 0) > 0) continue;

    const [task] = await db
      .insert(agentTaskQueue)
      .values({ agentId: ag.id, runtimeId: ag.runtimeId, issueId: issue.id, status: "queued", triggerCommentId: comment.id })
      .returning();
    if (task) enqueued.push(task.id);
  }
  return enqueued;
}

/**
 * Wake the issue's agent assignee when a member comments (port of Go
 * shouldEnqueueOnComment + the CreateComment EnqueueTaskForIssue call).
 * Comments are conversational — this fires for ANY issue status, including
 * after completion (follow-up questions on a done/in_review issue). Dedup
 * matches the mention path: skip when the agent already has a queued or
 * dispatched task here (a RUNNING task does not block — the agent picks the
 * new comment up on its next cycle). Returns the task id or null.
 */
export async function enqueueAssigneeOnComment(
  db: Db,
  issue: Issue,
  comment: Comment,
  authorType: string,
  authorId: string,
): Promise<string | null> {
  // Only member comments wake the assignee (an agent's own report must not
  // re-trigger it; agent→agent conversation rides the @mention path).
  if (authorType !== "member") return null;
  if (issue.assigneeType !== "agent" || !issue.assigneeId) return null;

  const [ag] = await db
    .select()
    .from(agentTbl)
    .where(and(eq(agentTbl.id, issue.assigneeId), eq(agentTbl.workspaceId, issue.workspaceId)));
  if (!ag || ag.archivedAt || !ag.runtimeId) return null;
  if (!(await canAccessPrivateAgent(db, ag, authorType, authorId))) return null;

  // Dedup — also covers a comment that just woke this agent via @mention.
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.issueId, issue.id),
        eq(agentTaskQueue.agentId, ag.id),
        inArray(agentTaskQueue.status, ["queued", "dispatched"]),
      ),
    );
  if ((pending?.n ?? 0) > 0) return null;

  const [task] = await db
    .insert(agentTaskQueue)
    .values({
      agentId: ag.id,
      runtimeId: ag.runtimeId,
      issueId: issue.id,
      status: "queued",
      triggerCommentId: comment.id,
    })
    .returning();
  return task?.id ?? null;
}
