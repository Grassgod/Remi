// Snake_case wire shapes for the workspace dashboard rollups. The frontend
// parses these with zod schemas whose fields all carry `.default(0)`
// (frontend/packages/core/api/schemas/dashboard.ts) — returning the store's
// camelCase rows verbatim "succeeds" parsing with every value defaulted to
// zero, which is exactly the MUL-92 dashboard-shows-all-zeros bug. Keep these
// converters in lockstep with those schemas.
import type {
  MultiremiAgentRuntime,
  MultiremiRuntimeDaily,
  MultiremiUsageByAgent,
  MultiremiUsageDaily,
} from "@multiremi/contracts/types.js";

export function dashboardUsageDailyWire(row: MultiremiUsageDaily): Record<string, unknown> {
  return {
    date: row.date,
    runtime_id: row.runtimeId ?? null,
    provider: row.provider,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    // Pre-0.2.49 daemons only reported the context-occupancy total; keep it on
    // the wire so historical rows (splits all zero) remain distinguishable
    // from genuinely empty days.
    total_tokens: row.totalTokens,
    task_count: row.taskCount,
  };
}

export function dashboardUsageByAgentWire(row: MultiremiUsageByAgent): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    total_tokens: row.totalTokens,
    task_count: row.taskCount,
  };
}

export function dashboardAgentRuntimeWire(row: MultiremiAgentRuntime): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    total_seconds: row.totalSeconds,
    task_count: row.taskCount,
    failed_count: row.failedCount,
  };
}

export function dashboardRuntimeDailyWire(row: MultiremiRuntimeDaily): Record<string, unknown> {
  return {
    date: row.date,
    total_seconds: row.totalSeconds,
    task_count: row.taskCount,
    failed_count: row.failedCount,
  };
}
