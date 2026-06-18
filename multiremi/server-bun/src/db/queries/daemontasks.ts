/**
 * Daemon write-path queries — the server-side counterpart to the Go daemon
 * handler (server/internal/handler/daemon.go). A remote daemon polls these to
 * keep its runtime alive, claim the next queued task, and report results.
 *
 * The read path (list/get runtimes) lives in queries/runtimes.ts; this file is
 * the write path only: heartbeat liveness, task claim context, task report.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agent, agentRuntime, agentTaskQueue, taskMessage, taskUsage } from "../schema.js";

export type AgentRuntime = typeof agentRuntime.$inferSelect;
export type AgentTask = typeof agentTaskQueue.$inferSelect;
export type Agent = typeof agent.$inferSelect;

/**
 * Resolve a runtime by UUID. Workspace authorization is applied by the caller
 * (the handler gates on the runtime's workspace_id), so this is an unscoped
 * lookup — null when the runtime row is gone (mirrors Go GetAgentRuntime →
 * pgx.ErrNoRows, which the daemon reads as "drop and re-register").
 */
export async function getAgentRuntime(db: Db, id: string): Promise<AgentRuntime | null> {
  const [rt] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, id));
  return rt ?? null;
}

/**
 * Mark a runtime alive: bump last_seen_at and flip status to 'online'. Mirrors
 * the Go heartbeat DB write (recordHeartbeat → HeartbeatScheduler). Returns the
 * updated row, or null when the runtime was deleted between lookup and write.
 */
export async function touchRuntimeHeartbeat(db: Db, id: string): Promise<AgentRuntime | null> {
  const [rt] = await db
    .update(agentRuntime)
    .set({ status: "online", lastSeenAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(agentRuntime.id, id))
    .returning();
  return rt ?? null;
}

/** Resolve a task by UUID (unscoped; caller authorizes via workspace). */
export async function getAgentTask(db: Db, id: string): Promise<AgentTask | null> {
  const [t] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, id));
  return t ?? null;
}

/** Resolve the agent that owns a task, so the claim response can carry its
 *  name + instructions + custom env/args (mirrors Go ClaimTaskByRuntime). */
export async function getAgentById(db: Db, id: string): Promise<Agent | null> {
  const [a] = await db.select().from(agent).where(eq(agent.id, id));
  return a ?? null;
}

export async function startAgentTask(
  db: Db,
  id: string,
  sessionId?: string,
  workDir?: string,
): Promise<AgentTask | null> {
  const [t] = await db
    .update(agentTaskQueue)
    .set({
      status: "running",
      startedAt: sql`coalesce(${agentTaskQueue.startedAt}, now())`,
      ...(sessionId ? { sessionId } : {}),
      ...(workDir ? { workDir } : {}),
    })
    .where(and(eq(agentTaskQueue.id, id), inArray(agentTaskQueue.status, ["dispatched", "running"])))
    .returning();
  return t ?? null;
}

export async function pinAgentTaskSession(
  db: Db,
  id: string,
  sessionId?: string,
  workDir?: string,
): Promise<AgentTask | null> {
  const [t] = await db
    .update(agentTaskQueue)
    .set({
      ...(sessionId ? { sessionId } : {}),
      ...(workDir ? { workDir } : {}),
    })
    .where(eq(agentTaskQueue.id, id))
    .returning();
  return t ?? null;
}

export interface TaskUsageInput {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TaskMessageInput {
  seq: number;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: unknown;
  output?: string | null;
}

export async function insertTaskMessages(
  db: Db,
  taskId: string,
  rows: TaskMessageInput[],
): Promise<Array<typeof taskMessage.$inferSelect>> {
  if (rows.length === 0) return [];
  return db
    .insert(taskMessage)
    .values(
      rows.map((row) => ({
        taskId,
        seq: row.seq,
        type: row.type,
        tool: row.tool ?? null,
        content: row.content ?? null,
        input: row.input ?? null,
        output: row.output ?? null,
      })),
    )
    .returning();
}

export async function upsertTaskUsage(db: Db, taskId: string, rows: TaskUsageInput[]): Promise<void> {
  for (const row of rows) {
    if (!row.provider || !row.model) continue;
    await db
      .insert(taskUsage)
      .values({
        taskId,
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cacheWriteTokens: row.cacheWriteTokens ?? 0,
      })
      .onConflictDoUpdate({
        target: [taskUsage.taskId, taskUsage.provider, taskUsage.model],
        set: {
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          cacheReadTokens: row.cacheReadTokens ?? 0,
          cacheWriteTokens: row.cacheWriteTokens ?? 0,
          updatedAt: sql`now()`,
        },
      });
  }
}

export async function recoverOrphanTasks(db: Db, runtimeId: string): Promise<number> {
  const rows = await db
    .update(agentTaskQueue)
    .set({
      status: "queued",
      dispatchedAt: null,
      startedAt: null,
      waitReason: null,
    })
    .where(
      and(
        eq(agentTaskQueue.runtimeId, runtimeId),
        inArray(agentTaskQueue.status, ["dispatched", "running", "waiting_local_directory"]),
      ),
    )
    .returning({ id: agentTaskQueue.id });
  return rows.length;
}

/**
 * Mark a running/dispatched task completed: write result + session_id + work_dir
 * and stamp completed_at. Mirrors CompleteAgentTask — the WHERE status guard
 * makes a double-report idempotent (a task already finalized by a racing daemon
 * returns no row). Returns the updated row, or null when nothing matched.
 */
export async function completeAgentTask(
  db: Db,
  id: string,
  result: unknown,
  sessionId?: string,
  workDir?: string,
): Promise<AgentTask | null> {
  const [t] = await db
    .update(agentTaskQueue)
    .set({
      status: "completed",
      completedAt: sql`now()`,
      result: result ?? null,
      ...(sessionId ? { sessionId } : {}),
      ...(workDir ? { workDir } : {}),
    })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        inArray(agentTaskQueue.status, ["dispatched", "running", "waiting_local_directory"]),
      ),
    )
    .returning();
  return t ?? null;
}

/**
 * Mark a task failed: write error text + failure_reason and stamp completed_at.
 * Mirrors FailAgentTask — the failure_reason defaults to 'agent_error' (the Go
 * COALESCE default) and the WHERE status guard keeps a double-report idempotent.
 */
export async function failAgentTask(
  db: Db,
  id: string,
  errorMsg: string,
  failureReason?: string,
  sessionId?: string,
  workDir?: string,
): Promise<AgentTask | null> {
  const [t] = await db
    .update(agentTaskQueue)
    .set({
      status: "failed",
      completedAt: sql`now()`,
      error: errorMsg,
      failureReason: failureReason && failureReason.length > 0 ? failureReason : "agent_error",
      ...(sessionId ? { sessionId } : {}),
      ...(workDir ? { workDir } : {}),
    })
    .where(
      and(
        eq(agentTaskQueue.id, id),
        inArray(agentTaskQueue.status, ["dispatched", "running", "waiting_local_directory"]),
      ),
    )
    .returning();
  return t ?? null;
}
