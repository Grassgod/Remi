/** Project queries — port of the Go project handler's read path (list + get). */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { issue, project, projectResource, type Project } from "../schema.js";

/** Insert shape for a project (mirrors Drizzle's $inferInsert). */
export type NewProject = typeof project.$inferInsert;

/** Per-project issue stats (mirrors Go GetProjectIssueStats). */
export interface ProjectIssueStats {
  totalCount: number;
  doneCount: number;
}

/**
 * List a workspace's projects, newest first, with optional status/priority
 * filters (mirrors Go ListProjects: ORDER BY created_at DESC).
 */
export async function listProjects(
  db: Db,
  wsId: string,
  filters: { status?: string; priority?: string } = {},
): Promise<Project[]> {
  const conds = [eq(project.workspaceId, wsId)];
  if (filters.status) conds.push(eq(project.status, filters.status));
  if (filters.priority) conds.push(eq(project.priority, filters.priority));
  return db
    .select()
    .from(project)
    .where(and(...conds))
    .orderBy(desc(project.createdAt));
}

/**
 * Resolve a project by UUID, scoped to the workspace (multi-tenancy).
 * Mirrors Go GetProjectInWorkspace. null = not found / wrong workspace.
 */
export async function getProjectInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<Project | null> {
  const [p] = await db
    .select()
    .from(project)
    .where(and(eq(project.id, id), eq(project.workspaceId, wsId)));
  return p ?? null;
}

/**
 * Insert a project (caller validates + supplies workspaceId, status, priority).
 * Mirrors Go CreateProject.
 */
export async function createProject(db: Db, input: NewProject): Promise<Project> {
  const [p] = await db.insert(project).values(input).returning();
  return p!;
}

/**
 * Partial update by primary key (caller resolves + authorizes the id first).
 * Mirrors Go UpdateProject's pointer-field semantics: only the keys present in
 * `fields` are touched. Bumps updated_at. null = not found.
 */
export async function updateProject(
  db: Db,
  id: string,
  fields: Partial<NewProject>,
): Promise<Project | null> {
  const [p] = await db
    .update(project)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(project.id, id))
    .returning();
  return p ?? null;
}

/** Delete a project by primary key (caller resolves + authorizes first). */
export async function deleteProject(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(project).where(eq(project.id, id)).returning({ id: project.id });
  return res.length > 0;
}

/**
 * Batch issue stats keyed by project id (mirrors Go GetProjectIssueStats):
 * total issue count + count of issues in a terminal status ('done'/'cancelled').
 */
export async function getProjectIssueStats(
  db: Db,
  projectIds: string[],
): Promise<Map<string, ProjectIssueStats>> {
  const out = new Map<string, ProjectIssueStats>();
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: issue.projectId,
      totalCount: sql<number>`count(*)::int`,
      doneCount: sql<number>`count(*) FILTER (WHERE ${issue.status} IN ('done', 'cancelled'))::int`,
    })
    .from(issue)
    .where(inArray(issue.projectId, projectIds))
    .groupBy(issue.projectId);
  for (const row of rows) {
    if (row.projectId) {
      out.set(row.projectId, { totalCount: row.totalCount, doneCount: row.doneCount });
    }
  }
  return out;
}

/**
 * Batch resource counts keyed by project id (mirrors Go
 * GetProjectResourceCounts).
 */
export async function getProjectResourceCounts(
  db: Db,
  projectIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: projectResource.projectId,
      resourceCount: sql<number>`count(*)::int`,
    })
    .from(projectResource)
    .where(inArray(projectResource.projectId, projectIds))
    .groupBy(projectResource.projectId);
  for (const row of rows) {
    out.set(row.projectId, row.resourceCount);
  }
  return out;
}
