/**
 * Per-runtime usage rollups — port of runtime.go's GetRuntimeUsage /
 * GetRuntimeUsageByAgent over task_usage_hourly, keyed on runtime_id (the
 * dashboard queries are the workspace-wide analog). The day-slice tz is inlined
 * as a validated SQL literal so SELECT/GROUP BY/ORDER BY render identically
 * (Postgres grouping requirement) and the value can't carry injection.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { taskUsageHourly } from "../schema.js";

function tzLiteral(tz: string) {
  const safe = /^[A-Za-z0-9_/+-]+$/.test(tz) ? tz : "UTC";
  return sql.raw(`'${safe}'`);
}

export interface RuntimeUsageDailyRow {
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface RuntimeUsageByAgentRow {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

const TOKENS = {
  inputTokens: sql<number>`sum(${taskUsageHourly.inputTokens})::bigint`,
  outputTokens: sql<number>`sum(${taskUsageHourly.outputTokens})::bigint`,
  cacheReadTokens: sql<number>`sum(${taskUsageHourly.cacheReadTokens})::bigint`,
  cacheWriteTokens: sql<number>`sum(${taskUsageHourly.cacheWriteTokens})::bigint`,
  taskCount: sql<number>`sum(${taskUsageHourly.taskCount})::int`,
};

/** Per-(date, provider, model) token totals for a runtime since `since`. */
export async function listRuntimeUsageDaily(db: Db, runtimeId: string, tz: string, since: Date): Promise<RuntimeUsageDailyRow[]> {
  const dateExpr = sql<string>`date(${taskUsageHourly.bucketHour} at time zone ${tzLiteral(tz)})`;
  return db
    .select({ date: dateExpr, provider: taskUsageHourly.provider, model: taskUsageHourly.model, ...TOKENS })
    .from(taskUsageHourly)
    .where(and(eq(taskUsageHourly.runtimeId, runtimeId), gte(taskUsageHourly.bucketHour, since.toISOString())))
    .groupBy(dateExpr, taskUsageHourly.provider, taskUsageHourly.model)
    .orderBy(sql`${dateExpr} desc`, taskUsageHourly.provider, taskUsageHourly.model);
}

/** Per-(agent, model) token totals for a runtime since `since`. */
export async function listRuntimeUsageByAgent(db: Db, runtimeId: string, since: Date): Promise<RuntimeUsageByAgentRow[]> {
  return db
    .select({ agentId: taskUsageHourly.agentId, model: taskUsageHourly.model, ...TOKENS })
    .from(taskUsageHourly)
    .where(and(eq(taskUsageHourly.runtimeId, runtimeId), gte(taskUsageHourly.bucketHour, since.toISOString())))
    .groupBy(taskUsageHourly.agentId, taskUsageHourly.model)
    .orderBy(taskUsageHourly.agentId, taskUsageHourly.model);
}
