/**
 * Runtime-admin queries — port of the Go runtime detail/admin path:
 * GetRuntimeTaskHourlyActivity + GetRuntimeUsageByHour (runtime_usage.sql) and
 * the ArchiveAgentsAndDeleteRuntime cascade (runtime.sql + agent.sql), used by
 * routes/runtimeAdmin.ts.
 *
 * The hour-of-day tz is inlined as a validated SQL literal so the SELECT /
 * GROUP BY / ORDER BY expressions render identically (Postgres grouping
 * requirement) and the value can't carry injection — same pattern as
 * runtimeUsage.ts.
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agent, agentRuntime, agentTaskQueue, autopilot, squad, taskUsageHourly } from "../schema.js";

export type Agent = typeof agent.$inferSelect;
export type AgentTask = typeof agentTaskQueue.$inferSelect;

function tzLiteral(tz: string) {
  const safe = /^[A-Za-z0-9_/+-]+$/.test(tz) ? tz : "UTC";
  return sql.raw(`'${safe}'`);
}

/**
 * UTC instant of local midnight `days` days before today in `tz`, computed in
 * SQL (Postgres owns the tz database). Port of Go sinceFromDays: the cutoff
 * yields N+1 calendar buckets (today-days … today inclusive) — deliberate
 * headroom for the runtime detail page's window math, not an off-by-one.
 */
function sinceExpr(tz: string, days: number) {
  const z = tzLiteral(tz);
  return sql`((date_trunc('day', now() at time zone ${z}) - make_interval(days => ${days}::int)) at time zone ${z})`;
}

// ---------------------------------------------------------------------------
// Hourly activity + usage by hour
// ---------------------------------------------------------------------------

export interface RuntimeHourlyActivityRow {
  hour: number;
  count: number;
}

/**
 * Hour-of-day distribution of task starts for a runtime, all time (port of
 * GetRuntimeTaskHourlyActivity over agent_task_queue.started_at). Bucketed in
 * the viewer's tz so "busy in the afternoon" means the operator's afternoon.
 */
export async function getRuntimeTaskHourlyActivity(
  db: Db,
  runtimeId: string,
  tz: string,
): Promise<RuntimeHourlyActivityRow[]> {
  const hourExpr = sql<number>`extract(hour from (${agentTaskQueue.startedAt} at time zone ${tzLiteral(tz)}))::int`;
  return db
    .select({ hour: hourExpr, count: sql<number>`count(*)::int` })
    .from(agentTaskQueue)
    .where(and(eq(agentTaskQueue.runtimeId, runtimeId), isNotNull(agentTaskQueue.startedAt)))
    .groupBy(hourExpr)
    .orderBy(hourExpr);
}

export interface RuntimeUsageByHourRow {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

/**
 * Per-(hour, model) token aggregates (hour ∈ 0..23) for a runtime since the
 * cutoff (port of GetRuntimeUsageByHour). Reads the task_usage_hourly rollup
 * like the other Bun usage queries (the Go side reads raw task_usage; the
 * rollup is this rewrite's storage for the same numbers). Hours with zero
 * activity are omitted — clients fill the 24-bucket axis. Model is preserved
 * for client-side cost math.
 */
export async function listRuntimeUsageByHour(
  db: Db,
  runtimeId: string,
  tz: string,
  days: number,
): Promise<RuntimeUsageByHourRow[]> {
  const hourExpr = sql<number>`extract(hour from (${taskUsageHourly.bucketHour} at time zone ${tzLiteral(tz)}))::int`;
  return db
    .select({
      hour: hourExpr,
      model: taskUsageHourly.model,
      inputTokens: sql<number>`sum(${taskUsageHourly.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${taskUsageHourly.outputTokens})::bigint`,
      cacheReadTokens: sql<number>`sum(${taskUsageHourly.cacheReadTokens})::bigint`,
      cacheWriteTokens: sql<number>`sum(${taskUsageHourly.cacheWriteTokens})::bigint`,
      taskCount: sql<number>`sum(${taskUsageHourly.taskCount})::int`,
    })
    .from(taskUsageHourly)
    .where(and(eq(taskUsageHourly.runtimeId, runtimeId), gte(taskUsageHourly.bucketHour, sinceExpr(tz, days))))
    .groupBy(hourExpr, taskUsageHourly.model)
    .orderBy(hourExpr, taskUsageHourly.model);
}

// ---------------------------------------------------------------------------
// Archive-agents-and-delete cascade
// ---------------------------------------------------------------------------

export type CascadeDeleteResult =
  /** Runtime + agents torn down; rows returned for post-commit event fan-out. */
  | { status: "ok"; archivedAgents: Agent[]; cancelledTasks: AgentTask[] }
  /** Live active-agent set ≠ the user-confirmed snapshot; nothing changed. */
  | { status: "plan_changed"; activeAgents: Agent[] }
  /** Runtime row vanished between the handler's load and our lock. */
  | { status: "lock_failed" };

/** Internal: thrown inside the tx to roll back and surface the fresh snapshot. */
class PlanChangedError extends Error {
  constructor(readonly activeAgents: Agent[]) {
    super("runtime delete plan changed");
  }
}

class LockFailedError extends Error {}

/**
 * Cascade teardown of a runtime (port of Go ArchiveAgentsAndDeleteRuntime's
 * transaction): archive every active agent bound to the runtime, cancel their
 * queued/dispatched/running tasks, pause autopilots that target the archived
 * agents, hard-delete the now-detached archived rows so the agent.runtime_id
 * FK (ON DELETE RESTRICT) no longer pins the runtime, then delete the runtime
 * row — all in ONE transaction so a partial failure never leaves a runtime
 * half-torn-down.
 *
 * Locking mirrors Go: FOR UPDATE on the runtime row blocks FK-validated
 * INSERT/UPDATEs that would point a new/moved agent at this runtime, and
 * FOR UPDATE on the active agent rows blocks a concurrent archive/move — so
 * the set compared against `expectedActiveAgentIds` is exactly the set the
 * archive operates on. A mismatch (teammate added/archived an agent while the
 * confirm dialog was open) rolls back and returns the fresh snapshot.
 */
export async function archiveAgentsAndDeleteRuntime(
  db: Db,
  runtimeId: string,
  expectedActiveAgentIds: ReadonlySet<string>,
  archivedBy: string,
): Promise<CascadeDeleteResult> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Lock the runtime row (Go LockAgentRuntime). FK validation on
      //    agent.runtime_id needs FOR KEY SHARE on this row, which conflicts
      //    with FOR UPDATE — concurrent INSERTs of new actives now block.
      const locked = await tx
        .select({ id: agentRuntime.id })
        .from(agentRuntime)
        .where(eq(agentRuntime.id, runtimeId))
        .for("update");
      if (locked.length === 0) throw new LockFailedError();

      // 2. Re-list active agents inside the tx with row locks
      //    (Go ListActiveAgentsByRuntimeForUpdate; ordered by name so the 409
      //    snapshot renders deterministically).
      const currentActive = await tx
        .select()
        .from(agent)
        .where(and(eq(agent.runtimeId, runtimeId), isNull(agent.archivedAt)))
        .orderBy(asc(agent.name))
        .for("update");

      // 3. The user must be approving exactly the set we're about to archive.
      if (
        currentActive.length !== expectedActiveAgentIds.size ||
        currentActive.some((a) => !expectedActiveAgentIds.has(a.id))
      ) {
        throw new PlanChangedError(currentActive);
      }

      // 4. Archive, keyed off the confirmed ID list (Go ArchiveAgentsByIDs) —
      //    not off runtime_id — so nothing outside the approved set can be
      //    silently archived. Defense in depth on top of the locks.
      const activeIds = currentActive.map((a) => a.id);
      let archivedAgents: Agent[] = [];
      if (activeIds.length > 0) {
        archivedAgents = await tx
          .update(agent)
          .set({ archivedAt: sql`now()`, archivedBy, updatedAt: sql`now()` })
          .where(and(inArray(agent.id, activeIds), isNull(agent.archivedAt)))
          .returning();
      }

      // 5. Cancel active tasks by runtime OR archived agent ids: an agent we
      //    just archived may still own tasks pinned to a different runtime
      //    (agent.runtime_id can be reassigned without rewriting historical
      //    queue rows). Go CancelAgentTasksByRuntimeOrAgent.
      const archivedIds = archivedAgents.map((a) => a.id);
      const cancelledTasks = await tx
        .update(agentTaskQueue)
        .set({ status: "cancelled", completedAt: sql`now()` })
        .where(
          and(
            or(
              eq(agentTaskQueue.runtimeId, runtimeId),
              archivedIds.length > 0 ? inArray(agentTaskQueue.agentId, archivedIds) : undefined,
            ),
            inArray(agentTaskQueue.status, ["queued", "dispatched", "running", "waiting_local_directory"]),
          ),
        )
        .returning();

      // 6. Pause autopilots whose agent assignee is ANY archived agent on this
      //    runtime — including ones archived before this call — because step 7
      //    hard-deletes the lot and a paused autopilot is louder in the UI
      //    than a silently-dangling assignee_id (no agent FK since Go
      //    migration 096). Go ListArchivedAgentIDsByRuntime + Pause…ByAgentAssignees.
      const allArchived = await tx
        .select({ id: agent.id })
        .from(agent)
        .where(and(eq(agent.runtimeId, runtimeId), isNotNull(agent.archivedAt)));
      if (allArchived.length > 0) {
        await tx
          .update(autopilot)
          .set({ status: "paused", updatedAt: sql`now()` })
          .where(
            and(
              eq(autopilot.status, "active"),
              eq(autopilot.assigneeType, "agent"),
              inArray(
                autopilot.assigneeId,
                allArchived.map((a) => a.id),
              ),
            ),
          );
      }

      // 7. Squads led by an agent we're about to hard-delete: squad.leader_id
      //    is ON DELETE RESTRICT and NOT NULL, so an archived squad whose
      //    leader dies with this runtime must be dropped with it (a leaderless
      //    archived squad row can't exist). An ACTIVE squad blocks upstream
      //    via the squads UI; if one still points here the FK will surface it.
      if (allArchived.length > 0) {
        await tx.delete(squad).where(
          and(
            inArray(
              squad.leaderId,
              allArchived.map((a) => a.id),
            ),
            isNotNull(squad.archivedAt),
          ),
        );
      }

      // 8. Hard-delete the archived agents so agent.runtime_id (ON DELETE
      //    RESTRICT) no longer keeps the runtime alive.
      await tx.delete(agent).where(and(eq(agent.runtimeId, runtimeId), isNotNull(agent.archivedAt)));

      // 9. Finally drop the runtime row itself.
      await tx.delete(agentRuntime).where(eq(agentRuntime.id, runtimeId));

      return { status: "ok" as const, archivedAgents, cancelledTasks };
    });
  } catch (e) {
    if (e instanceof PlanChangedError) return { status: "plan_changed", activeAgents: e.activeAgents };
    if (e instanceof LockFailedError) return { status: "lock_failed" };
    throw e;
  }
}
