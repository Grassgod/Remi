import { z } from "zod";

const count = z.number().finite().int().nonnegative();
const amount = z.number().finite().nonnegative();
export const UsageMetricsSchema = z.object({
  actual_input_tokens: count, actual_output_tokens: count, actual_cache_read_tokens: count,
  actual_cache_write_tokens: count, actual_unsplit_tokens: count, actual_total_tokens: count,
  unknown_task_count: count, context_peak_tokens: count.nullable(), task_count: count, total_seconds: amount,
  known_cost_by_currency: z.record(z.string().regex(/^[A-Z]{3}$/), amount), priced_tokens: count, unpriced_tokens: count,
  reference_cost_by_currency: z.record(z.string().regex(/^[A-Z]{3}$/), amount).optional(),
  sdk_estimate_cost_by_currency: z.record(z.string().regex(/^[A-Z]{3}$/), amount).optional(),
  price_quality: z.string(), complete: z.boolean(),
  status_counts: z.object({ completed: count, failed: count, cancelled: count, active: count, queued: count }).loose(),
}).loose();

export const UsageReportSchema = z.object({
  summary: UsageMetricsSchema,
  daily: z.array(UsageMetricsSchema.extend({ date: z.string() })),
  by_agent: z.array(UsageMetricsSchema.extend({ agent_id: z.string() })),
  by_model: z.array(UsageMetricsSchema.extend({ provider: z.string(), model: z.string().nullable(), requested_model: z.string().nullable(), model_source: z.string(), model_provenance: z.string(), purpose: z.string().optional(), connection_id: z.string().nullable() })),
  by_runtime: z.array(UsageMetricsSchema.extend({ runtime_id: z.string().nullable(), runtime_provenance: z.string() })),
  task_daily: z.array(z.object({ date: z.string(), task_count: count, total_seconds: amount, status_counts: UsageMetricsSchema.shape.status_counts }).loose()),
  time_basis: z.object({ consumption: z.string(), terminal_tasks: z.string(), active_tasks: z.string() }).loose(),
  coverage: z.object({ priced_tokens: count, unpriced_tokens: count, token_ratio: z.number().min(0).max(1).nullable(), unknown_task_count: count }).loose(),
  as_of: z.string(), pricing_revision: z.string(),
  window: z.object({ since: z.string().nullable(), until: z.string().nullable(), days: count.nullable(), tz: z.string(), project_id: z.string().nullable(), runtime_id: z.string().nullable() }).loose(),
}).loose().superRefine((report, ctx) => {
  const rows = [report.summary, ...report.daily, ...report.by_agent, ...report.by_model, ...report.by_runtime];
  for (const r of rows) {
    const sum = r.actual_input_tokens + r.actual_output_tokens + r.actual_cache_read_tokens + r.actual_cache_write_tokens + r.actual_unsplit_tokens;
    if (sum !== r.actual_total_tokens || r.priced_tokens + r.unpriced_tokens !== r.actual_total_tokens || r.unknown_task_count > r.task_count) ctx.addIssue({ code: "custom", message: "Usage totals do not reconcile" });
  }
});

export const UsagePriceSchema = z.object({
  id: z.string(), workspace_id: z.string(), provider: z.string(), model: z.string(), connection_id: z.string().nullable(), requested_model_alias: z.boolean(), currency: z.string().regex(/^[A-Z]{3}$/),
  input_per_million: amount.nullable(), output_per_million: amount.nullable(), cache_read_per_million: amount.nullable(), cache_write_per_million: amount.nullable(), unsplit_per_million: amount.nullable(),
  source: z.string(), source_url: z.string().nullable(), effective_from: z.string(), effective_to: z.string().nullable(), created_at: z.string(),
}).loose();
export const UsagePricesSchema = z.object({ prices: z.array(UsagePriceSchema) }).loose();
