/** Skill queries — port of the Go skill handler's read + write paths. */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { skill, skillFile } from "../schema.js";

export type Skill = typeof skill.$inferSelect;
export type SkillFile = typeof skillFile.$inferSelect;
export type NewSkill = typeof skill.$inferInsert;

/**
 * The list-endpoint projection: every column except `content`. SKILL.md bodies
 * routinely run 50-200KB and shipping them in list payloads bloats responses
 * past CLI timeouts (mirrors Go ListSkillSummariesByWorkspace / GH #2174).
 */
export type SkillSummary = Pick<
  Skill,
  "id" | "workspaceId" | "name" | "description" | "config" | "createdBy" | "createdAt" | "updatedAt"
>;

/**
 * List a workspace's skills as summaries (no `content`), ordered by name ASC.
 * Mirrors Go ListSkillSummariesByWorkspace.
 */
export async function listSkillSummariesByWorkspace(
  db: Db,
  wsId: string,
): Promise<SkillSummary[]> {
  return db
    .select({
      id: skill.id,
      workspaceId: skill.workspaceId,
      name: skill.name,
      description: skill.description,
      config: skill.config,
      createdBy: skill.createdBy,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    })
    .from(skill)
    .where(eq(skill.workspaceId, wsId))
    .orderBy(asc(skill.name));
}

/**
 * Resolve a skill by UUID, scoped to the workspace (multi-tenancy).
 * Mirrors Go GetSkillInWorkspace. null = not found / wrong workspace.
 */
export async function getSkillInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<Skill | null> {
  const [s] = await db
    .select()
    .from(skill)
    .where(and(eq(skill.id, id), eq(skill.workspaceId, wsId)));
  return s ?? null;
}

/** List a skill's supporting files, ordered by path ASC (mirrors Go ListSkillFiles). */
export async function listSkillFiles(db: Db, skillId: string): Promise<SkillFile[]> {
  return db
    .select()
    .from(skillFile)
    .where(eq(skillFile.skillId, skillId))
    .orderBy(asc(skillFile.path));
}

/**
 * Insert a skill (mirrors Go CreateSkill). The UNIQUE(workspace_id, name)
 * constraint (migration 008) surfaces as a Postgres 23505 — callers map it to
 * a 409 conflict.
 */
export async function createSkill(db: Db, input: NewSkill): Promise<Skill> {
  const [s] = await db.insert(skill).values(input).returning();
  return s!;
}

/**
 * Reuse a workspace skill by name, or create it (empty content). Used when
 * materialising an agent template's skill refs — the upstream source_url
 * content fetch is deferred, so a freshly-created skill carries only the
 * template's cached name + description.
 */
export async function findOrCreateSkillByName(
  db: Db,
  wsId: string,
  name: string,
  description: string,
  createdBy: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: skill.id })
    .from(skill)
    .where(and(eq(skill.workspaceId, wsId), eq(skill.name, name)));
  if (existing) return existing.id;
  const [created] = await db
    .insert(skill)
    .values({ workspaceId: wsId, name, description, content: "", createdBy })
    .returning({ id: skill.id });
  return created!.id;
}

/**
 * Partial update by primary key (caller resolves + authorizes the id first).
 * Mirrors Go UpdateSkill: only the provided columns are written; absent fields
 * are preserved. updated_at is always bumped.
 */
export async function updateSkill(
  db: Db,
  id: string,
  fields: Partial<Pick<NewSkill, "name" | "description" | "content" | "config">>,
): Promise<Skill | null> {
  const [s] = await db
    .update(skill)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(skill.id, id))
    .returning();
  return s ?? null;
}

/**
 * Delete a skill, scoped to its workspace (defense-in-depth tenant guard,
 * mirrors Go DeleteSkill). skill_file rows cascade. Returns true if a row was
 * removed.
 */
export async function deleteSkill(db: Db, id: string, wsId: string): Promise<boolean> {
  const res = await db
    .delete(skill)
    .where(and(eq(skill.id, id), eq(skill.workspaceId, wsId)))
    .returning({ id: skill.id });
  return res.length > 0;
}
