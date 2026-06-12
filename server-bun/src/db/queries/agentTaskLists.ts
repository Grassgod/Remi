/**
 * Read-only list queries for agent task history and autopilot run history.
 * Ports of the Go sqlc queries (server/pkg/db/queries/agent.sql +
 * autopilot.sql): ListAgentTasks, ListAutopilotRuns, GetAutopilotRun.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentTaskQueue, autopilotRun } from "../schema.js";

export type AgentTaskRow = typeof agentTaskQueue.$inferSelect;
export type AutopilotRunRow = typeof autopilotRun.$inferSelect;

/** Mirrors Go ListAgentTasks: every queue row for an agent, newest first. */
export async function listAgentTasks(db: Db, agentId: string): Promise<AgentTaskRow[]> {
  return db
    .select()
    .from(agentTaskQueue)
    .where(eq(agentTaskQueue.agentId, agentId))
    .orderBy(desc(agentTaskQueue.createdAt));
}

/**
 * Mirrors Go ListAutopilotRuns: an autopilot's runs newest-first with
 * LIMIT/OFFSET pagination (caller clamps the values, like the Go handler).
 */
export async function listAutopilotRuns(
  db: Db,
  autopilotId: string,
  limit: number,
  offset: number,
): Promise<AutopilotRunRow[]> {
  return db
    .select()
    .from(autopilotRun)
    .where(eq(autopilotRun.autopilotId, autopilotId))
    .orderBy(desc(autopilotRun.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Mirrors Go GetAutopilotRun: a single run by id. The route re-checks that the
 * run belongs to the URL's autopilot so a guessed runId from another autopilot
 * (or workspace) cannot leak data — fail closed with 404 on mismatch.
 */
export async function getAutopilotRun(db: Db, runId: string): Promise<AutopilotRunRow | null> {
  const [r] = await db.select().from(autopilotRun).where(eq(autopilotRun.id, runId));
  return r ?? null;
}
