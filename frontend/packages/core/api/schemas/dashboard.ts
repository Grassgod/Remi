import { z } from "zod";

// ---------------------------------------------------------------------------
// Workspace dashboard schemas
//
// The dashboard hits four independent rollup endpoints. Each returns a flat
// array whose every field drives KPI / chart math.
//
// These schemas are deliberately STRICT (MUL-93): a row missing a numeric
// field means the wire contract drifted, and silently defaulting it to 0
// used to render fabricated "$0.00 / 0 tokens / 0 tasks" as if they were
// confirmed measurements. The dashboard endpoints now parse with
// `parseStrictResponse`, so a drifted body raises ApiContractError → the
// query lands in `isError` → the page shows an explicit "data unavailable"
// state with a retry, never zeros.
//
// Contract semantics, for both sides of the wire:
//   - HTTP 2xx + valid body + empty array  → genuinely no usage in range
//     (the UI is allowed to render 0 and say "no tasks in this window").
//   - HTTP error, or 2xx body that fails these schemas → metric UNAVAILABLE
//     (the UI must render a placeholder + reason, never 0 / $0.00).
//
// `.loose()` still keeps unknown extra fields so purely additive server
// changes never break older clients.
// ---------------------------------------------------------------------------

const DashboardUsageDailySchema = z.object({
  date: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  task_count: z.number(),
}).loose();

export const DashboardUsageDailyListSchema = z.array(DashboardUsageDailySchema);

const DashboardUsageByAgentSchema = z.object({
  agent_id: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  task_count: z.number(),
}).loose();

export const DashboardUsageByAgentListSchema = z.array(DashboardUsageByAgentSchema);

const DashboardAgentRunTimeSchema = z.object({
  agent_id: z.string(),
  total_seconds: z.number(),
  task_count: z.number(),
  failed_count: z.number(),
}).loose();

export const DashboardAgentRunTimeListSchema = z.array(DashboardAgentRunTimeSchema);

const DashboardRunTimeDailySchema = z.object({
  date: z.string(),
  total_seconds: z.number(),
  task_count: z.number(),
  failed_count: z.number(),
}).loose();

export const DashboardRunTimeDailyListSchema = z.array(DashboardRunTimeDailySchema);
