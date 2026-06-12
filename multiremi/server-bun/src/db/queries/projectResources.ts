/**
 * Project resources — the rows that bind a project to a place an agent runs:
 *   - `github_repo`     → a git URL; the daemon checks out a fresh worktree.
 *   - `local_directory` → an existing path on a specific daemon; run in-place.
 * Mirrors the Go `project_resource` handler + daemon resolution. The resolved
 * `RepoPlan` is what the executor turns into the agent's working directory.
 */

import { and, eq, asc, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { projectResource } from "../schema.js";

export type ProjectResource = typeof projectResource.$inferSelect;

export interface GithubRepoRef {
  url: string;
  default_branch_hint?: string;
}

export interface LocalDirectoryRef {
  local_path: string;
  daemon_id: string;
  label?: string;
}

export type RepoPlan =
  | { kind: "repo"; url: string; branchHint?: string }
  | { kind: "local"; localPath: string; daemonId: string }
  | { kind: "none" };

/** All resources for a project, ordered by position (the UI's display order). */
export async function listProjectResources(db: Db, projectId: string) {
  return db
    .select()
    .from(projectResource)
    .where(eq(projectResource.projectId, projectId))
    .orderBy(asc(projectResource.position));
}

/** Number of resources attached to a project (mirrors Go CountProjectResources). */
export async function countProjectResources(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectResource)
    .where(eq(projectResource.projectId, projectId));
  return Number(row?.count ?? 0);
}

/** Insert a resource row (mirrors Go CreateProjectResource). The caller maps
 * the UNIQUE(project_id, resource_type, resource_ref) violation to 409. */
export async function createProjectResource(
  db: Db,
  input: {
    projectId: string;
    workspaceId: string;
    resourceType: string;
    resourceRef: Record<string, unknown>;
    label: string | null;
    position: number;
    createdBy: string | null;
  },
): Promise<ProjectResource> {
  const [row] = await db
    .insert(projectResource)
    .values({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      label: input.label,
      position: input.position,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

/**
 * Workspace-scoped resource lookup (mirrors Go GetProjectResourceInWorkspace) —
 * a forged id from another workspace returns null instead of leaking existence.
 */
export async function getProjectResourceInWorkspace(
  db: Db,
  id: string,
  wsId: string,
): Promise<ProjectResource | null> {
  const [row] = await db
    .select()
    .from(projectResource)
    .where(and(eq(projectResource.id, id), eq(projectResource.workspaceId, wsId)));
  return row ?? null;
}

/** Overwrite ref/label/position (mirrors Go UpdateProjectResource — the route
 * computes the next values from the existing row first; resource_type is
 * immutable). Returns the updated row, or null when the id no longer exists. */
export async function updateProjectResource(
  db: Db,
  id: string,
  next: { resourceRef: unknown; label: string | null; position: number },
): Promise<ProjectResource | null> {
  const [row] = await db
    .update(projectResource)
    .set({ resourceRef: next.resourceRef, label: next.label, position: next.position })
    .where(eq(projectResource.id, id))
    .returning();
  return row ?? null;
}

/** Delete a resource row (mirrors Go DeleteProjectResource). */
export async function deleteProjectResource(db: Db, id: string): Promise<boolean> {
  const removed = await db
    .delete(projectResource)
    .where(eq(projectResource.id, id))
    .returning({ id: projectResource.id });
  return removed.length > 0;
}

/**
 * Resolve a project's run target. A `local_directory` pinned to `daemonId`
 * wins (run in-place on that machine); otherwise the first `github_repo`
 * (fresh worktree). When `daemonId` is omitted, any `local_directory` matches
 * — single-daemon deployments don't disambiguate.
 */
export async function resolveRepoPlan(db: Db, projectId: string, daemonId?: string): Promise<RepoPlan> {
  const rows = await listProjectResources(db, projectId);
  let repo: RepoPlan | null = null;
  for (const row of rows) {
    if (row.resourceType === "local_directory") {
      const ref = row.resourceRef as LocalDirectoryRef;
      if (ref.local_path && (!daemonId || ref.daemon_id === daemonId)) {
        return { kind: "local", localPath: ref.local_path, daemonId: ref.daemon_id };
      }
    } else if (row.resourceType === "github_repo" && !repo) {
      const ref = row.resourceRef as GithubRepoRef;
      if (ref.url) repo = { kind: "repo", url: ref.url, branchHint: ref.default_branch_hint };
    }
  }
  return repo ?? { kind: "none" };
}
