/** Agent queries — port of the Go agent handler's read + write paths. */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agent, agentRuntime, agentSkill, agentTaskQueue, member, skill, type Agent, type Member } from "../schema.js";

/** Insert shape for the agent table (no NewAgent type is exported by schema.ts). */
export type NewAgent = typeof agent.$inferInsert;

/** Select shape for the agent_runtime table (no type is exported by schema.ts). */
export type AgentRuntime = typeof agentRuntime.$inferSelect;

/** Membership gate (mirrors Go GetMemberByUserAndWorkspace). null = not a member. */
export async function getMembership(db: Db, userId: string, wsId: string): Promise<Member | null> {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, wsId)));
  return m ?? null;
}

/**
 * List a workspace's agents. Mirrors Go ListAgents / ListAllAgents:
 * ordered by created_at ASC; archived agents are excluded unless
 * includeArchived is set.
 */
export async function listAgents(db: Db, wsId: string, includeArchived = false): Promise<Agent[]> {
  const where = includeArchived
    ? eq(agent.workspaceId, wsId)
    : and(eq(agent.workspaceId, wsId), isNull(agent.archivedAt));
  return db.select().from(agent).where(where).orderBy(asc(agent.createdAt));
}

/**
 * Resolve a single agent by UUID, scoped to the workspace (multi-tenancy).
 * Mirrors the Go loader's GetAgentInWorkspace. null = not found in this ws.
 */
export async function getAgentInWorkspace(
  db: Db,
  wsId: string,
  agentId: string,
): Promise<Agent | null> {
  const [a] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.workspaceId, wsId)));
  return a ?? null;
}

/** A single skill summary embedded on an agent response (id/name/description). */
export type AgentSkillSummaryRow = { agentId: string; id: string; name: string; description: string };

/**
 * Batch-load skill summaries for every agent in a workspace, to avoid N+1.
 * Mirrors Go ListAgentSkillsByWorkspace (JOIN agent_skill → skill, ordered by
 * skill.name ASC).
 */
export async function listAgentSkillsByWorkspace(
  db: Db,
  wsId: string,
): Promise<AgentSkillSummaryRow[]> {
  return db
    .select({
      agentId: agentSkill.agentId,
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })
    .from(agentSkill)
    .innerJoin(skill, eq(skill.id, agentSkill.skillId))
    .where(eq(skill.workspaceId, wsId))
    .orderBy(asc(skill.name));
}

/**
 * Load skill summaries for one agent. Mirrors Go ListAgentSkillSummaries
 * (JOIN skill → agent_skill, ordered by skill.name ASC). Omits the large
 * `content` column on purpose (see #2174 / the summary SQL).
 */
export async function listAgentSkillSummaries(
  db: Db,
  agentId: string,
): Promise<Array<{ id: string; name: string; description: string }>> {
  return db
    .select({ id: skill.id, name: skill.name, description: skill.description })
    .from(skill)
    .innerJoin(agentSkill, eq(agentSkill.skillId, skill.id))
    .where(eq(agentSkill.agentId, agentId))
    .orderBy(asc(skill.name));
}

/**
 * Resolve a runtime by UUID, scoped to the workspace. Mirrors Go's
 * GetAgentRuntimeForWorkspace — used by create/update to validate the
 * supplied runtime_id exists in this workspace before binding an agent to it.
 * null = no such runtime in this workspace.
 */
export async function getAgentRuntimeForWorkspace(
  db: Db,
  wsId: string,
  runtimeId: string,
): Promise<AgentRuntime | null> {
  const [rt] = await db
    .select()
    .from(agentRuntime)
    .where(and(eq(agentRuntime.id, runtimeId), eq(agentRuntime.workspaceId, wsId)));
  return rt ?? null;
}

/** Insert a new agent. Mirrors Go's CreateAgent. */
export async function createAgent(db: Db, input: NewAgent): Promise<Agent> {
  const [a] = await db.insert(agent).values(input).returning();
  return a!;
}

/**
 * Partial update by primary key (caller resolves + authorizes the id first).
 * Mirrors Go's UpdateAgent: only the fields present in `fields` are written,
 * and updated_at is bumped. Returns null when no row matched.
 */
export async function updateAgent(
  db: Db,
  id: string,
  fields: Partial<NewAgent>,
): Promise<Agent | null> {
  const [a] = await db
    .update(agent)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(agent.id, id))
    .returning();
  return a ?? null;
}

/**
 * Soft-delete: set archived_at = now() and archived_by = userId. Mirrors Go's
 * ArchiveAgent. The id + archivedBy are resolved/validated by the caller.
 * Returns null when no row matched.
 */
export async function archiveAgent(
  db: Db,
  id: string,
  archivedBy: string,
): Promise<Agent | null> {
  const [a] = await db
    .update(agent)
    .set({ archivedAt: sql`now()`, archivedBy, updatedAt: sql`now()` })
    .where(eq(agent.id, id))
    .returning();
  return a ?? null;
}

/** Clear the archive marker (mirrors Go RestoreAgent). */
export async function restoreAgent(db: Db, id: string): Promise<Agent | null> {
  const [a] = await db
    .update(agent)
    .set({ archivedAt: null, archivedBy: null, updatedAt: sql`now()` })
    .where(eq(agent.id, id))
    .returning();
  return a ?? null;
}

/**
 * Cancel an agent's not-yet-terminal tasks (queued/dispatched/running/
 * waiting_local_directory → cancelled). Returns the number cancelled. Used by
 * archive + the explicit cancel-tasks endpoint (Go CancelAgentTasksByAgent).
 */
export async function cancelAgentTasks(db: Db, agentId: string): Promise<number> {
  const rows = await db
    .update(agentTaskQueue)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(
      and(
        eq(agentTaskQueue.agentId, agentId),
        inArray(agentTaskQueue.status, ["queued", "dispatched", "running", "waiting_local_directory"]),
      ),
    )
    .returning({ id: agentTaskQueue.id });
  return rows.length;
}
