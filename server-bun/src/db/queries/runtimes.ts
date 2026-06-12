/**
 * Agent-runtime queries — port of the Go runtime handler. Read path (list +
 * get) plus the member-facing write path (register / update / delete) used by
 * routes/runtimes.ts. The daemon upsert + heartbeat writes live elsewhere
 * (routes/daemontasks.ts) and are intentionally not duplicated here.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentRuntime } from "../schema.js";

export type AgentRuntime = typeof agentRuntime.$inferSelect;
export type NewAgentRuntime = typeof agentRuntime.$inferInsert;

/**
 * List a workspace's agent runtimes, oldest first (mirrors Go ListAgentRuntimes:
 * ORDER BY created_at ASC). When ownerId is supplied, scopes to runtimes owned
 * by that user (mirrors ListAgentRuntimesByOwner, used for `?owner=me`).
 */
export async function listAgentRuntimes(
  db: Db,
  wsId: string,
  ownerId?: string,
): Promise<AgentRuntime[]> {
  const conds = [eq(agentRuntime.workspaceId, wsId)];
  if (ownerId) conds.push(eq(agentRuntime.ownerId, ownerId));
  return db
    .select()
    .from(agentRuntime)
    .where(and(...conds))
    .orderBy(asc(agentRuntime.createdAt));
}

/**
 * Resolve an agent runtime by UUID, scoped to the workspace (multi-tenancy).
 * null = not found / wrong workspace.
 */
export async function getAgentRuntimeInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<AgentRuntime | null> {
  const [rt] = await db
    .select()
    .from(agentRuntime)
    .where(and(eq(agentRuntime.id, id), eq(agentRuntime.workspaceId, wsId)));
  return rt ?? null;
}

/**
 * Insert a new agent runtime. The caller resolves + authorizes the workspace
 * and stamps owner_id from the authenticated member (mirrors the Go register
 * handler's OwnerID = member.UserID). Returns the inserted row.
 */
export async function createAgentRuntime(db: Db, input: NewAgentRuntime): Promise<AgentRuntime> {
  const [rt] = await db.insert(agentRuntime).values(input).returning();
  return rt!;
}

/**
 * Partial update of an agent runtime by primary key (caller resolves +
 * authorizes the id first). Touches updated_at like the Go update queries.
 * Returns null if the row vanished between the load and the write.
 */
export async function updateAgentRuntime(
  db: Db,
  id: string,
  fields: Partial<NewAgentRuntime>,
): Promise<AgentRuntime | null> {
  const [rt] = await db
    .update(agentRuntime)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(agentRuntime.id, id))
    .returning();
  return rt ?? null;
}

/** Delete a runtime by primary key (caller resolves + authorizes first). */
export async function deleteAgentRuntime(db: Db, id: string): Promise<boolean> {
  const res = await db
    .delete(agentRuntime)
    .where(eq(agentRuntime.id, id))
    .returning({ id: agentRuntime.id });
  return res.length > 0;
}
