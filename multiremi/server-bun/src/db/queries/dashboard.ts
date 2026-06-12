/**
 * Dashboard queries — port of the Go dashboard handler's read path
 * (server/internal/handler/dashboard.go + pkg/db/queries/task_usage.sql).
 *
 * Four workspace-wide rollups power the "/{slug}/dashboard" page:
 *   - usage daily       per-(date, model) token aggregates
 *   - usage by agent    per-(agent, model) token aggregates
 *   - agent run time     per-agent terminal-task run time + counts
 *   - run time daily     per-date terminal-task run time + counts
 *
 * All are backed by the UTC-bucketed `task_usage_hourly` table (token rows)
 * or `agent_task_queue` joined to `agent` (run-time rows), keyed on
 * workspace_id with an optional project_id filter. Counts and durations
 * mirror the sqlc SUM/COUNT shapes exactly.
 */

import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { Db } from "../client.js";
import { agent, agentTaskQueue, issue, taskUsageHourly } from "../schema.js";

/**
 * Build the `date(<column> at time zone '<tz>')` day-slice expression with the
 * tz inlined as a quoted SQL literal. Inlining (rather than a bound param) is
 * required because Postgres only collapses a SELECT/GROUP BY/ORDER BY clause
 * into the same grouping expression when the rendered SQL text is byte-for-byte
 * identical — a `$N` placeholder differs per clause and trips
 * "must appear in the GROUP BY clause". The tz is caller-validated against the
 * IANA zone set upstream (resolveViewingTz), so it can never carry injection.
 */
function dateInTz(column: SQLWrapper, tz: string): SQL<string> {
  const lit = sql.raw(`'${tz.replace(/'/g, "''")}'`);
  return sql<string>`date(${column} at time zone ${lit})`;
}

/** One (date, model) token bucket. Mirrors DashboardUsageDailyResponse. */
export interface DashboardUsageDailyRow {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

/** One (agent, model) token row. Mirrors DashboardUsageByAgentResponse. */
export interface DashboardUsageByAgentRow {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

/** One agent's terminal-task run time. Mirrors DashboardAgentRunTimeResponse. */
export interface DashboardAgentRunTimeRow {
  agentId: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

/** One (date) run-time bucket. Mirrors DashboardRunTimeDailyResponse. */
export interface DashboardRunTimeDailyRow {
  date: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

/**
 * Daily per-(date, model) token aggregates, served from the UTC-bucketed
 * `task_usage_hourly` rows and sliced to calendar days under `tz`. Optionally
 * scoped to a project. `since` is already the viewer's local start-of-day-(N)
 * as a UTC instant (see sinceFromDays); it is passed straight through and must
 * NOT be re-truncated. Mirrors ListDashboardUsageDaily.
 */
export async function listDashboardUsageDaily(
  db: Db,
  wsId: string,
  tz: string,
  since: Date,
  projectId: string | null,
): Promise<DashboardUsageDailyRow[]> {
  const dateExpr = dateInTz(taskUsageHourly.bucketHour, tz);
  const rows = await db
    .select({
      date: dateExpr,
      model: taskUsageHourly.model,
      inputTokens: sql<number>`sum(${taskUsageHourly.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${taskUsageHourly.outputTokens})::bigint`,
      cacheReadTokens: sql<number>`sum(${taskUsageHourly.cacheReadTokens})::bigint`,
      cacheWriteTokens: sql<number>`sum(${taskUsageHourly.cacheWriteTokens})::bigint`,
      taskCount: sql<number>`sum(${taskUsageHourly.taskCount})::int`,
    })
    .from(taskUsageHourly)
    .where(
      and(
        eq(taskUsageHourly.workspaceId, wsId),
        gte(taskUsageHourly.bucketHour, since.toISOString()),
        projectId === null ? undefined : eq(taskUsageHourly.projectId, projectId),
      ),
    )
    .groupBy(dateExpr, taskUsageHourly.model)
    .orderBy(sql`${dateExpr} desc`, taskUsageHourly.model);
  return rows.map((r) => ({
    date: r.date,
    model: r.model,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    taskCount: Number(r.taskCount),
  }));
}

/**
 * Per-(agent, model) token aggregates from `task_usage_hourly`. No date
 * grouping, so no tz — `since` is the already-computed cutoff. Optionally
 * scoped to a project. Mirrors ListDashboardUsageByAgent.
 */
export async function listDashboardUsageByAgent(
  db: Db,
  wsId: string,
  since: Date,
  projectId: string | null,
): Promise<DashboardUsageByAgentRow[]> {
  const rows = await db
    .select({
      agentId: taskUsageHourly.agentId,
      model: taskUsageHourly.model,
      inputTokens: sql<number>`sum(${taskUsageHourly.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${taskUsageHourly.outputTokens})::bigint`,
      cacheReadTokens: sql<number>`sum(${taskUsageHourly.cacheReadTokens})::bigint`,
      cacheWriteTokens: sql<number>`sum(${taskUsageHourly.cacheWriteTokens})::bigint`,
      taskCount: sql<number>`sum(${taskUsageHourly.taskCount})::int`,
    })
    .from(taskUsageHourly)
    .where(
      and(
        eq(taskUsageHourly.workspaceId, wsId),
        gte(taskUsageHourly.bucketHour, since.toISOString()),
        projectId === null ? undefined : eq(taskUsageHourly.projectId, projectId),
      ),
    )
    .groupBy(taskUsageHourly.agentId, taskUsageHourly.model)
    .orderBy(taskUsageHourly.agentId, taskUsageHourly.model);
  return rows.map((r) => ({
    agentId: r.agentId,
    model: r.model,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    taskCount: Number(r.taskCount),
  }));
}

/**
 * Per-agent total terminal-task run time (seconds) + task/failed counts.
 * Only completed/failed tasks with both started_at and completed_at populated
 * contribute. Anchored on completed_at >= `since`. Optionally scoped to a
 * project via the issue's project_id. Mirrors ListDashboardAgentRunTime.
 */
export async function listDashboardAgentRunTime(
  db: Db,
  wsId: string,
  since: Date,
  projectId: string | null,
): Promise<DashboardAgentRunTimeRow[]> {
  const totalSeconds = sql<number>`coalesce(sum(extract(epoch from (${agentTaskQueue.completedAt} - ${agentTaskQueue.startedAt})))::bigint, 0)::bigint`;
  const rows = await db
    .select({
      agentId: agentTaskQueue.agentId,
      totalSeconds,
      taskCount: sql<number>`count(*)::int`,
      failedCount: sql<number>`count(*) filter (where ${agentTaskQueue.status} = 'failed')::int`,
    })
    .from(agentTaskQueue)
    .innerJoin(agent, eq(agent.id, agentTaskQueue.agentId))
    .leftJoin(issue, eq(issue.id, agentTaskQueue.issueId))
    .where(
      and(
        eq(agent.workspaceId, wsId),
        sql`${agentTaskQueue.status} in ('completed', 'failed')`,
        sql`${agentTaskQueue.startedAt} is not null`,
        sql`${agentTaskQueue.completedAt} is not null`,
        gte(agentTaskQueue.completedAt, since.toISOString()),
        projectId === null
          ? undefined
          : or(isNull(issue.id), eq(issue.projectId, projectId)),
      ),
    )
    .groupBy(agentTaskQueue.agentId)
    .orderBy(sql`${totalSeconds} desc`);
  return rows.map((r) => ({
    agentId: r.agentId,
    totalSeconds: Number(r.totalSeconds),
    taskCount: Number(r.taskCount),
    failedCount: Number(r.failedCount),
  }));
}

/**
 * Per-date terminal-task run time (seconds) + task/failed counts, sliced into
 * calendar days under `tz`, bucketed by completed_at. Same terminal-task /
 * project-scope rules as listDashboardAgentRunTime. Mirrors
 * ListDashboardRunTimeDaily.
 */
export async function listDashboardRunTimeDaily(
  db: Db,
  wsId: string,
  tz: string,
  since: Date,
  projectId: string | null,
): Promise<DashboardRunTimeDailyRow[]> {
  const dateExpr = dateInTz(agentTaskQueue.completedAt, tz);
  const rows = await db
    .select({
      date: dateExpr,
      totalSeconds: sql<number>`coalesce(sum(extract(epoch from (${agentTaskQueue.completedAt} - ${agentTaskQueue.startedAt})))::bigint, 0)::bigint`,
      taskCount: sql<number>`count(*)::int`,
      failedCount: sql<number>`count(*) filter (where ${agentTaskQueue.status} = 'failed')::int`,
    })
    .from(agentTaskQueue)
    .innerJoin(agent, eq(agent.id, agentTaskQueue.agentId))
    .leftJoin(issue, eq(issue.id, agentTaskQueue.issueId))
    .where(
      and(
        eq(agent.workspaceId, wsId),
        sql`${agentTaskQueue.status} in ('completed', 'failed')`,
        sql`${agentTaskQueue.startedAt} is not null`,
        sql`${agentTaskQueue.completedAt} is not null`,
        gte(agentTaskQueue.completedAt, since.toISOString()),
        projectId === null
          ? undefined
          : or(isNull(issue.id), eq(issue.projectId, projectId)),
      ),
    )
    .groupBy(dateExpr)
    .orderBy(sql`${dateExpr} desc`);
  return rows.map((r) => ({
    date: r.date,
    totalSeconds: Number(r.totalSeconds),
    taskCount: Number(r.taskCount),
    failedCount: Number(r.failedCount),
  }));
}
