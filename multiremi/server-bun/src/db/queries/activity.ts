/**
 * Activity-log queries — port of the Go activity handler's read path.
 *
 * Two read scopes:
 *   - per issue: all activity_log rows for one issue, chronological ASC, capped
 *     (mirrors Go ListActivitiesForIssue: WHERE issue_id = $1 ORDER BY
 *     created_at ASC, id ASC LIMIT $2).
 *   - per workspace: all activity_log rows for a workspace, newest first, capped
 *     (workspace-scoped multi-tenancy read).
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { activityLog } from "../schema.js";

/** Row shape — activity_log has no pre-exported type in schema.ts. */
export type ActivityLog = typeof activityLog.$inferSelect;

/**
 * Per-issue / per-workspace payload cap. Mirrors Go's timelineHardCap (2000):
 * a defensive safety net to bound the response, not a UX page window.
 */
export const ACTIVITY_HARD_CAP = 2000;

/**
 * All activity-log rows for an issue, oldest first (mirrors Go
 * ListActivitiesForIssue). The issue must already be resolved + authorized to
 * the workspace by the caller (multi-tenancy gate lives in the route).
 */
export async function listActivitiesForIssue(db: Db, issueId: string): Promise<ActivityLog[]> {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.issueId, issueId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
    .limit(ACTIVITY_HARD_CAP);
}

/**
 * All activity-log rows for a workspace, newest first (workspace-scoped read).
 * Every query filters by workspace_id (multi-tenancy).
 */
export async function listActivitiesForWorkspace(db: Db, wsId: string): Promise<ActivityLog[]> {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, wsId))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(ACTIVITY_HARD_CAP);
}

/**
 * Resolve a single activity-log row by UUID, scoped to the workspace
 * (multi-tenancy). null = not found / wrong workspace.
 */
export async function getActivityInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<ActivityLog | null> {
  const [a] = await db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.id, id), eq(activityLog.workspaceId, wsId)));
  return a ?? null;
}
