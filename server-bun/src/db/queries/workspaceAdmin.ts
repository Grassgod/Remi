/**
 * Workspace admin queries — port of the Go workspace settings write path:
 * get/update/delete workspace (server/pkg/db/queries/workspace.sql), member
 * lookup + role update (member.sql), and the member-revocation transaction
 * (server/internal/handler/workspace_revoke.go: revokeAndRemoveMember).
 *
 * The revocation converges all server-side state that should follow a member
 * leaving a workspace: every runtime they own is forced offline, every agent
 * pinned to one of those runtimes is archived, every in-flight task on those
 * runtimes (or left behind by those agents on other runtimes) is cancelled,
 * the daemon_token rows for those runtimes are deleted, and finally the
 * member row itself is removed. All writes run in one transaction so a
 * partial revocation never leaves the workspace half-converged.
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  agent,
  agentRuntime,
  agentTaskQueue,
  daemonToken,
  member,
  user,
  workspace,
  type Agent,
  type Member,
  type User,
  type Workspace,
} from "../schema.js";

/** Cancelled-task row (schema.ts exports tables; derive the row type locally). */
export type AgentTaskRow = typeof agentTaskQueue.$inferSelect;

/** Mirrors SQL GetWorkspace (workspace.sql). null = no such workspace. */
export async function getWorkspaceById(db: Db, id: string): Promise<Workspace | null> {
  const [w] = await db.select().from(workspace).where(eq(workspace.id, id));
  return w ?? null;
}

/**
 * Partial update input. `undefined` = keep the current value (the SQL
 * UpdateWorkspace uses COALESCE(narg, col) per column). Slug is intentionally
 * absent — the Go UpdateWorkspaceRequest has no slug field; slugs are
 * immutable after creation.
 */
export interface UpdateWorkspacePatch {
  name?: string;
  description?: string;
  context?: string;
  settings?: unknown;
  repos?: unknown;
  issuePrefix?: string;
  avatarUrl?: string;
}

/** Mirrors SQL UpdateWorkspace: set only the provided columns + updated_at = now(). */
export async function updateWorkspace(
  db: Db,
  id: string,
  patch: UpdateWorkspacePatch,
): Promise<Workspace | null> {
  const [w] = await db
    .update(workspace)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
      ...(patch.repos !== undefined ? { repos: patch.repos } : {}),
      ...(patch.issuePrefix !== undefined ? { issuePrefix: patch.issuePrefix } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(workspace.id, id))
    .returning();
  return w ?? null;
}

/**
 * Mirrors SQL DeleteWorkspace. The DB's ON DELETE CASCADE FKs take the
 * dependent rows (members, issues, agents, ...) with it, exactly like Go.
 */
export async function deleteWorkspaceById(db: Db, id: string): Promise<void> {
  await db.delete(workspace).where(eq(workspace.id, id));
}

/** Mirrors SQL GetMember (member.sql). null = no such member row. */
export async function getMemberById(db: Db, memberId: string): Promise<Member | null> {
  const [m] = await db.select().from(member).where(eq(member.id, memberId));
  return m ?? null;
}

/** Mirrors SQL ListMembers: all member rows of a workspace, created_at ASC. */
export async function listMembers(db: Db, wsId: string): Promise<Member[]> {
  return db
    .select()
    .from(member)
    .where(eq(member.workspaceId, wsId))
    .orderBy(asc(member.createdAt));
}

/** Mirrors Go countOwners (handler.go) — the last-owner guard input. */
export function countOwners(members: Member[]): number {
  return members.filter((m) => m.role === "owner").length;
}

/** Mirrors SQL UpdateMemberRole. null = member row vanished concurrently. */
export async function updateMemberRole(
  db: Db,
  memberId: string,
  role: string,
): Promise<Member | null> {
  const [m] = await db
    .update(member)
    .set({ role })
    .where(eq(member.id, memberId))
    .returning();
  return m ?? null;
}

/** User lookup for the MemberWithUser response (kept local — domain self-contained). */
export async function getUserById(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(user).where(eq(user.id, id));
  return u ?? null;
}

/**
 * Everything the revocation touched, so the route can fan out the post-commit
 * events (task:cancelled, agent:archived, daemon:register) exactly like Go's
 * publishRevocation. Publishing happens after the tx commits — never inside.
 */
export interface RevocationResult {
  archivedAgents: Agent[];
  cancelledTasks: AgentTaskRow[];
  offlineRuntimeIds: string[];
  revokedTokenHashes: string[];
}

/** Statuses CancelAgentTasksByRuntimeOrAgent treats as still-active (runtime.sql). */
const ACTIVE_TASK_STATUSES = ["queued", "dispatched", "running", "waiting_local_directory"];

/**
 * Port of Go revokeAndRemoveMember (workspace_revoke.go). One transaction:
 *
 *  1. find every agent_runtime in the workspace owned by the leaving user
 *  2. archive every active agent bound to those runtimes
 *  3. cancel every active task on those runtimes OR belonging to those agents
 *     (cancelled, not failed, so the daemon's status poller interrupts
 *     gracefully; the agent-side OR covers tasks an agent left behind on a
 *     different runtime after an UpdateAgent runtime reassignment)
 *  4. force the runtimes offline (unconditional — intentional revocation)
 *  5. delete the daemon_token rows for those runtimes' daemons
 *  6. delete the member row itself
 *
 * `archivedBy` is the actor who triggered the revocation: the requester for a
 * kick (DeleteMember), the leaver themselves for LeaveWorkspace.
 */
export async function revokeAndRemoveMember(
  db: Db,
  args: { workspaceId: string; userId: string; memberId: string; archivedBy: string },
): Promise<RevocationResult> {
  return db.transaction(async (tx) => {
    const result: RevocationResult = {
      archivedAgents: [],
      cancelledTasks: [],
      offlineRuntimeIds: [],
      revokedTokenHashes: [],
    };

    const runtimes = await tx
      .select()
      .from(agentRuntime)
      .where(
        and(eq(agentRuntime.workspaceId, args.workspaceId), eq(agentRuntime.ownerId, args.userId)),
      );

    if (runtimes.length > 0) {
      const runtimeIds = runtimes.map((r) => r.id);
      const daemonIds = runtimes
        .map((r) => r.daemonId)
        .filter((d): d is string => typeof d === "string" && d !== "");

      // ArchiveAgentsByRuntime (agent.sql): only active agents, RETURNING *.
      result.archivedAgents = await tx
        .update(agent)
        .set({ archivedAt: sql`now()`, archivedBy: args.archivedBy, updatedAt: sql`now()` })
        .where(and(inArray(agent.runtimeId, runtimeIds), isNull(agent.archivedAt)))
        .returning();

      // CancelAgentTasksByRuntimeOrAgent (runtime.sql). Guard the agent-side
      // IN against an empty list (drizzle inArray([]) is invalid SQL; Go's
      // = ANY('{}') is simply false).
      const agentIds = result.archivedAgents.map((a) => a.id);
      const ownership =
        agentIds.length > 0
          ? or(inArray(agentTaskQueue.runtimeId, runtimeIds), inArray(agentTaskQueue.agentId, agentIds))
          : inArray(agentTaskQueue.runtimeId, runtimeIds);
      result.cancelledTasks = await tx
        .update(agentTaskQueue)
        .set({ status: "cancelled", completedAt: sql`now()` })
        .where(and(ownership, inArray(agentTaskQueue.status, ACTIVE_TASK_STATUSES)))
        .returning();

      // ForceOfflineRuntimesByIDs (runtime.sql): unconditional flip of online → offline.
      const offline = await tx
        .update(agentRuntime)
        .set({ status: "offline", updatedAt: sql`now()` })
        .where(and(inArray(agentRuntime.id, runtimeIds), eq(agentRuntime.status, "online")))
        .returning({ id: agentRuntime.id });
      result.offlineRuntimeIds = offline.map((r) => r.id);

      // DeleteDaemonTokensByWorkspaceAndDaemons (daemon_token.sql).
      if (daemonIds.length > 0) {
        const tokens = await tx
          .delete(daemonToken)
          .where(
            and(eq(daemonToken.workspaceId, args.workspaceId), inArray(daemonToken.daemonId, daemonIds)),
          )
          .returning({ tokenHash: daemonToken.tokenHash });
        result.revokedTokenHashes = tokens.map((t) => t.tokenHash);
      }
    }

    // Member-row deletion lives inside the same tx: a successful revoke is
    // never followed by a failed member-delete and vice versa (Go comment).
    await tx.delete(member).where(eq(member.id, args.memberId));

    return result;
  });
}
