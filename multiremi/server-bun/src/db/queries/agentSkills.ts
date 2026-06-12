/**
 * Agent ↔ skill assignment — the agent_skill join (port of the Go skill.go
 * agent-skill handlers). Lets an agent be granted a set of workspace skills it
 * brings into every task.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentSkill, skill } from "../schema.js";

/** A skill row (schema.ts exports the table, not the type). */
export type Skill = typeof skill.$inferSelect;

/** The skills currently assigned to an agent, ordered by name. */
export async function listAgentSkills(db: Db, agentId: string): Promise<Skill[]> {
  return db
    .select({
      id: skill.id,
      workspaceId: skill.workspaceId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      config: skill.config,
      createdBy: skill.createdBy,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    })
    .from(agentSkill)
    .innerJoin(skill, eq(agentSkill.skillId, skill.id))
    .where(eq(agentSkill.agentId, agentId))
    .orderBy(skill.name);
}

/** Of `ids`, the subset that are real skills in `wsId` (for validation). */
export async function skillIdsInWorkspace(db: Db, wsId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: skill.id })
    .from(skill)
    .where(and(eq(skill.workspaceId, wsId), inArray(skill.id, ids)));
  return new Set(rows.map((r) => r.id));
}

/** Replace the agent's skill set with exactly `skillIds` (transactional). */
export async function setAgentSkills(db: Db, agentId: string, skillIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(agentSkill).where(eq(agentSkill.agentId, agentId));
    if (skillIds.length > 0) {
      await tx.insert(agentSkill).values(skillIds.map((skillId) => ({ agentId, skillId })));
    }
  });
}

/** Add `skillIds` to the agent without removing existing ones (idempotent). */
export async function addAgentSkills(db: Db, agentId: string, skillIds: string[]): Promise<void> {
  if (skillIds.length === 0) return;
  await db
    .insert(agentSkill)
    .values(skillIds.map((skillId) => ({ agentId, skillId })))
    .onConflictDoNothing();
}
