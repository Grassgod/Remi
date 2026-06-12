/**
 * Autopilot queries — port of the Go autopilot handler's read/create path:
 * list + get (workspace-scoped) + create + list-triggers. The cron scheduler
 * and webhook dispatch execution are intentionally out of scope here; this
 * module covers only the CRUD read/create surface and the trigger list.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { autopilot, autopilotTrigger } from "../schema.js";

export type Autopilot = typeof autopilot.$inferSelect;
export type NewAutopilot = typeof autopilot.$inferInsert;
export type AutopilotTrigger = typeof autopilotTrigger.$inferSelect;

/**
 * List a workspace's autopilots, newest first (mirrors Go ListAutopilots:
 * WHERE workspace_id = $1 AND (status filter) ORDER BY created_at DESC). When
 * `status` is provided, only rows with that status are returned.
 */
export async function listAutopilots(
  db: Db,
  wsId: string,
  status?: string | null,
): Promise<Autopilot[]> {
  const where =
    status && status !== ""
      ? and(eq(autopilot.workspaceId, wsId), eq(autopilot.status, status))
      : eq(autopilot.workspaceId, wsId);
  return db.select().from(autopilot).where(where).orderBy(desc(autopilot.createdAt));
}

/**
 * Resolve a single autopilot by UUID, scoped to the workspace (multi-tenancy).
 * Mirrors the Go loader's GetAutopilotInWorkspace (id + workspace_id).
 * null = not found / wrong workspace.
 */
export async function getAutopilotInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<Autopilot | null> {
  const [a] = await db
    .select()
    .from(autopilot)
    .where(and(eq(autopilot.id, id), eq(autopilot.workspaceId, wsId)));
  return a ?? null;
}

/** Insert an autopilot (caller resolves + authorizes the workspace + assignee first). */
export async function createAutopilot(db: Db, input: NewAutopilot): Promise<Autopilot> {
  const [a] = await db.insert(autopilot).values(input).returning();
  return a!;
}

/**
 * List an autopilot's triggers, oldest first (mirrors Go ListAutopilotTriggers:
 * WHERE autopilot_id = $1 ORDER BY created_at ASC).
 */
export async function listAutopilotTriggers(
  db: Db,
  autopilotId: string,
): Promise<AutopilotTrigger[]> {
  return db
    .select()
    .from(autopilotTrigger)
    .where(eq(autopilotTrigger.autopilotId, autopilotId))
    .orderBy(asc(autopilotTrigger.createdAt));
}
