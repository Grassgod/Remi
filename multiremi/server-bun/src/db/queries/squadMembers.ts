/**
 * Squad member queries — back GET /api/squads/:id/members (static list) and
 * GET /api/squads/:id/members/status (derived live status). Ports the Go
 * ListSquadMembers + ListSquadMemberStatusRows SQL
 * (server/pkg/db/queries/squad.sql).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  agent,
  agentRuntime,
  agentTaskQueue,
  issue,
  squadMember,
  workspace,
} from "../schema.js";
import { generateIssuePrefix } from "./workspace.js";

export type SquadMemberRow = typeof squadMember.$inferSelect;

/**
 * Task states that occupy an agent slot (mirror the Go join's status IN
 * ('dispatched','running','waiting_local_directory')): the `working` bucket is
 * defined by task presence, not by whether the task has an issue.
 */
const ACTIVE_TASK_STATUSES = ["dispatched", "running", "waiting_local_directory"];

/** All members of a squad in insertion order (mirrors Go ListSquadMembers). */
export async function listSquadMembers(db: Db, squadId: string): Promise<SquadMemberRow[]> {
  return db
    .select()
    .from(squadMember)
    .where(eq(squadMember.squadId, squadId))
    .orderBy(asc(squadMember.createdAt));
}

/**
 * One row per (squad_member × active task); members with no active task get a
 * single row with null task_* columns. Human members and agent members with no
 * agent row get null agent_/runtime_ columns (mirrors Go
 * ListSquadMemberStatusRows). The route aggregates rows by memberId.
 */
export interface SquadMemberStatusRow {
  memberType: string;
  memberId: string;
  agentArchivedAt: string | null;
  runtimeStatus: string | null;
  runtimeLastSeenAt: string | null;
  taskId: string | null;
  taskIssueId: string | null;
  taskDispatchedAt: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  issueStatus: string | null;
}

export async function listSquadMemberStatusRows(
  db: Db,
  squadId: string,
): Promise<SquadMemberStatusRow[]> {
  return db
    .select({
      memberType: squadMember.memberType,
      memberId: squadMember.memberId,
      agentArchivedAt: agent.archivedAt,
      runtimeStatus: agentRuntime.status,
      runtimeLastSeenAt: agentRuntime.lastSeenAt,
      taskId: agentTaskQueue.id,
      taskIssueId: agentTaskQueue.issueId,
      taskDispatchedAt: agentTaskQueue.dispatchedAt,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueStatus: issue.status,
    })
    .from(squadMember)
    .leftJoin(agent, and(eq(squadMember.memberType, "agent"), eq(agent.id, squadMember.memberId)))
    .leftJoin(agentRuntime, eq(agentRuntime.id, agent.runtimeId))
    .leftJoin(
      agentTaskQueue,
      and(
        eq(squadMember.memberType, "agent"),
        eq(agentTaskQueue.agentId, squadMember.memberId),
        inArray(agentTaskQueue.status, ACTIVE_TASK_STATUSES),
      ),
    )
    .leftJoin(issue, eq(issue.id, agentTaskQueue.issueId))
    .where(eq(squadMember.squadId, squadId))
    .orderBy(asc(squadMember.createdAt), sql`${agentTaskQueue.dispatchedAt} desc nulls last`);
}

/**
 * The workspace's issue identifier prefix, with the Go getIssuePrefix
 * fallback: when the stored prefix is empty (workspaces predating the
 * column), derive one from the workspace name.
 */
export async function getIssuePrefixForWorkspace(db: Db, wsId: string): Promise<string> {
  const [w] = await db
    .select({ issuePrefix: workspace.issuePrefix, name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, wsId));
  if (!w) return "";
  return w.issuePrefix || generateIssuePrefix(w.name);
}
