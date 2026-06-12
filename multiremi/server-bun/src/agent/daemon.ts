/**
 * Minimal daemon claim loop. The Go daemon's claim→dispatch→execute→report
 * chain, collapsed: a runtime claims the oldest queued task atomically
 * (FOR UPDATE SKIP LOCKED — concurrency-safe across multiple daemons), then
 * runs it through the unified ACP executor, which writes the result back.
 *
 * This is intentionally small: the heavy Go daemon machinery (repocache, git
 * worktrees, CODEX_HOME scaffolding, auto-update, heartbeat WS) is NOT ported
 * here — that is follow-up work. This is the orchestration spine that makes
 * end-to-end agent scheduling work against the new ACP provider.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTaskQueue } from "../db/schema.js";
import { AcpProvider } from "./acp/index.js";
import { executeAgentTask, type ExecuteTaskOptions, type TaskOutcome } from "./executor.js";

export type AgentTask = typeof agentTaskQueue.$inferSelect;

/**
 * Atomically claim the oldest queued task for this runtime. Returns null when
 * the queue is empty. FOR UPDATE SKIP LOCKED guarantees two daemons never claim
 * the same row (mirrors the Go claim chain's at-most-once dispatch).
 */
export async function claimNextTask(db: Db, runtimeId: string): Promise<AgentTask | null> {
  const res = await db.execute(sql`
    UPDATE agent_task_queue SET status = 'dispatched', dispatched_at = now()
    WHERE id = (
      SELECT id FROM agent_task_queue
      WHERE runtime_id = ${runtimeId} AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const rows = res as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) return null;
  const [task] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, id));
  return task ?? null;
}

/**
 * Claim one task for the runtime and run it through the unified ACP executor.
 * Returns null when there was nothing to claim, else the task outcome.
 */
export async function claimAndRun(
  db: Db,
  provider: AcpProvider,
  runtimeId: string,
  opts: ExecuteTaskOptions = {},
): Promise<{ taskId: string; outcome: TaskOutcome } | null> {
  const task = await claimNextTask(db, runtimeId);
  if (!task) return null;
  const outcome = await executeAgentTask(db, provider, task.id, opts);
  return { taskId: task.id, outcome };
}

/** Claim + run until the runtime's queue is empty. Returns how many ran. */
export async function drainQueue(
  db: Db,
  provider: AcpProvider,
  runtimeId: string,
  opts: ExecuteTaskOptions = {},
): Promise<number> {
  let n = 0;
  for (;;) {
    const ran = await claimAndRun(db, provider, runtimeId, opts);
    if (!ran) return n;
    n += 1;
  }
}

export interface DaemonLoopOptions extends ExecuteTaskOptions {
  /** Poll interval when the queue is empty (ms). */
  intervalMs?: number;
  /** Stop the loop. */
  signal?: AbortSignal;
}

/**
 * Long-running poll loop: drain the queue, then wait `intervalMs` and repeat.
 * The Go daemon is woken by a WS signal; this polls (a WS wakeup is a later
 * optimization). Stops when `signal` aborts.
 */
export async function runDaemonLoop(
  db: Db,
  provider: AcpProvider,
  runtimeId: string,
  opts: DaemonLoopOptions = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 2000;
  while (!opts.signal?.aborted) {
    try {
      const ran = await drainQueue(db, provider, runtimeId, opts);
      if (ran === 0) await sleep(interval, opts.signal);
    } catch {
      await sleep(interval, opts.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
