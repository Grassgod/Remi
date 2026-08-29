/**
 * Rebuild historical Codex task totals from raw usage_update messages.
 *
 * Default mode is read-only. Execution requires both --execute and
 * --confirm=MUL-196 after the production operator has explicitly authorized it.
 * The raw event has no input/output/cache split, so rewritten entries are
 * deliberately totals-only and remain ineligible for cost calculation.
 */
import { openMultiremiDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { parseTaskUsageEntries, type RuntimeUsageEntry } from "../packages/server/src/store/helpers.js";

const EXECUTION_CONFIRMATION = "MUL-196";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

interface TaskRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  status: string;
  usage: string;
}

interface UsageMessageRow {
  task_id: string;
  meta: string | null;
}

export interface CodexUsageBackfillUpdate {
  taskId: string;
  agentId: string;
  agentName: string;
  eventCount: number;
  beforeTotalTokens: number;
  afterTotalTokens: number;
  expectedUsage: string;
  usage: RuntimeUsageEntry[];
}

export interface CodexUsageBackfillPlan {
  updates: CodexUsageBackfillUpdate[];
  skipped: {
    nonTerminal: number;
    missingCodexUsage: number;
    ambiguousCodexModels: number;
    missingUsageEvents: number;
    alreadyCorrect: number;
  };
}

export interface CodexUsageBackfillSummary {
  mode: "dry-run" | "execute";
  affectedTasks: number;
  beforeTotalTokens: number;
  afterTotalTokens: number;
  byAgent: Array<{
    agentId: string;
    agentName: string;
    affectedTasks: number;
    beforeTotalTokens: number;
    afterTotalTokens: number;
  }>;
  skipped: CodexUsageBackfillPlan["skipped"];
}

export function buildCodexUsageBackfillPlan(db: SqlDatabase): CodexUsageBackfillPlan {
  const tasks = db.query(
    `SELECT t.id, t.agent_id, a.name AS agent_name, t.status, t.usage
     FROM multiremi_tasks t
     LEFT JOIN multiremi_agents a ON a.id = t.agent_id
     WHERE t.provider = 'codex'
     ORDER BY t.id`,
  ).all() as TaskRow[];
  const messages = db.query(
    `SELECT m.task_id, m.meta
     FROM multiremi_task_messages m
     INNER JOIN multiremi_tasks t ON t.id = m.task_id
     WHERE t.provider = 'codex' AND m.type = 'usage'
     ORDER BY m.task_id, m.seq`,
  ).all() as UsageMessageRow[];

  const eventTotals = new Map<string, { count: number; total: number }>();
  for (const message of messages) {
    const used = usageEventUsed(message.meta);
    if (used == null) continue;
    const aggregate = eventTotals.get(message.task_id) ?? { count: 0, total: 0 };
    aggregate.count += 1;
    aggregate.total += used;
    eventTotals.set(message.task_id, aggregate);
  }

  const skipped = {
    nonTerminal: 0,
    missingCodexUsage: 0,
    ambiguousCodexModels: 0,
    missingUsageEvents: 0,
    alreadyCorrect: 0,
  };
  const updates: CodexUsageBackfillUpdate[] = [];

  for (const task of tasks) {
    if (!TERMINAL_STATUSES.has(task.status)) {
      skipped.nonTerminal += 1;
      continue;
    }
    const usage = parseTaskUsageEntries(task.usage);
    const codexIndexes = usage.flatMap((entry, index) => entry.provider === "codex" ? [index] : []);
    if (codexIndexes.length === 0) {
      skipped.missingCodexUsage += 1;
      continue;
    }
    if (codexIndexes.length !== 1) {
      // Raw usage messages do not identify the model, so assigning one total
      // across multiple historical model rows would fabricate attribution.
      skipped.ambiguousCodexModels += 1;
      continue;
    }
    const events = eventTotals.get(task.id);
    if (!events || events.count === 0 || events.total <= 0) {
      skipped.missingUsageEvents += 1;
      continue;
    }

    const codexIndex = codexIndexes[0]!;
    const previous = usage[codexIndex]!;
    const beforeTotalTokens = effectiveTotal(previous);
    const next: RuntimeUsageEntry = {
      ...previous,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: events.total,
    };
    if (isSameUsage(previous, next)) {
      skipped.alreadyCorrect += 1;
      continue;
    }
    const rewritten = [...usage];
    rewritten[codexIndex] = next;
    updates.push({
      taskId: task.id,
      agentId: task.agent_id,
      agentName: task.agent_name ?? task.agent_id,
      eventCount: events.count,
      beforeTotalTokens,
      afterTotalTokens: events.total,
      expectedUsage: task.usage,
      usage: rewritten,
    });
  }

  return { updates, skipped };
}

export function summarizeCodexUsageBackfill(
  plan: CodexUsageBackfillPlan,
  mode: "dry-run" | "execute",
): CodexUsageBackfillSummary {
  const byAgent = new Map<string, CodexUsageBackfillSummary["byAgent"][number]>();
  let beforeTotalTokens = 0;
  let afterTotalTokens = 0;
  for (const update of plan.updates) {
    beforeTotalTokens += update.beforeTotalTokens;
    afterTotalTokens += update.afterTotalTokens;
    const current = byAgent.get(update.agentId) ?? {
      agentId: update.agentId,
      agentName: update.agentName,
      affectedTasks: 0,
      beforeTotalTokens: 0,
      afterTotalTokens: 0,
    };
    current.affectedTasks += 1;
    current.beforeTotalTokens += update.beforeTotalTokens;
    current.afterTotalTokens += update.afterTotalTokens;
    byAgent.set(update.agentId, current);
  }
  return {
    mode,
    affectedTasks: plan.updates.length,
    beforeTotalTokens,
    afterTotalTokens,
    byAgent: [...byAgent.values()].sort((a, b) => a.agentName.localeCompare(b.agentName)),
    skipped: plan.skipped,
  };
}

export function applyCodexUsageBackfill(db: SqlDatabase, plan: CodexUsageBackfillPlan, updatedAt: string): number {
  const update = db.prepare("UPDATE multiremi_tasks SET usage = ?, updated_at = ? WHERE id = ? AND usage = ?");
  return db.transaction(() => {
    let changed = 0;
    for (const item of plan.updates) {
      const result = update.run(JSON.stringify(item.usage), updatedAt, item.taskId, item.expectedUsage);
      if (result.changes !== 1) {
        throw new Error(`task usage changed after dry-run plan: ${item.taskId}`);
      }
      changed += result.changes;
    }
    return changed;
  })();
}

function usageEventUsed(meta: string | null): number | null {
  if (!meta) return null;
  try {
    const raw = (JSON.parse(meta) as Record<string, unknown>)?.used;
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  } catch {
    return null;
  }
}

function effectiveTotal(entry: RuntimeUsageEntry): number {
  if (entry.totalTokens > 0) return entry.totalTokens;
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
}

function isSameUsage(left: RuntimeUsageEntry, right: RuntimeUsageEntry): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.totalTokens === right.totalTokens;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const confirmation = process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
  if (execute && confirmation !== EXECUTION_CONFIRMATION) {
    throw new Error(`execution requires --execute --confirm=${EXECUTION_CONFIRMATION}`);
  }

  const db = openMultiremiDatabase();
  try {
    const plan = buildCodexUsageBackfillPlan(db);
    const mode = execute ? "execute" : "dry-run";
    process.stdout.write(`${JSON.stringify(summarizeCodexUsageBackfill(plan, mode), null, 2)}\n`);
    if (!execute) {
      process.stdout.write(`Dry run only. Execution requires explicit authorization and --execute --confirm=${EXECUTION_CONFIRMATION}.\n`);
      return;
    }
    const changed = applyCodexUsageBackfill(db, plan, new Date().toISOString());
    process.stdout.write(`${JSON.stringify({ changedTasks: changed }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
