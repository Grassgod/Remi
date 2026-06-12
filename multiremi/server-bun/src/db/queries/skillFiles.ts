/**
 * Skill files — the multi-file content of a skill (port of skill.go's
 * ListSkillFiles / UpsertSkillFile / DeleteSkillFile over the skill_file table,
 * unique on (skill_id, path)).
 */

import { and, eq, asc, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { skill, skillFile } from "../schema.js";

export type SkillFile = typeof skillFile.$inferSelect;

/** Resolve a skill within a workspace (tenancy guard for the file routes). */
export async function getSkillInWorkspace(db: Db, wsId: string, skillId: string) {
  const [s] = await db.select().from(skill).where(and(eq(skill.id, skillId), eq(skill.workspaceId, wsId)));
  return s ?? null;
}

/** A skill's files, ordered by path. */
export async function listSkillFiles(db: Db, skillId: string): Promise<SkillFile[]> {
  return db.select().from(skillFile).where(eq(skillFile.skillId, skillId)).orderBy(asc(skillFile.path));
}

/** Upsert files by (skill_id, path); existing paths have their content refreshed. */
export async function upsertSkillFiles(db: Db, skillId: string, files: { path: string; content: string }[]): Promise<void> {
  for (const f of files) {
    await db
      .insert(skillFile)
      .values({ skillId, path: f.path, content: f.content })
      .onConflictDoUpdate({ target: [skillFile.skillId, skillFile.path], set: { content: f.content, updatedAt: sql`now()` } });
  }
}

/** Delete one file by id, scoped to its skill. Returns true if a row was removed. */
export async function deleteSkillFile(db: Db, skillId: string, fileId: string): Promise<boolean> {
  const rows = await db
    .delete(skillFile)
    .where(and(eq(skillFile.id, fileId), eq(skillFile.skillId, skillId)))
    .returning({ id: skillFile.id });
  return rows.length > 0;
}
