import type { UsageMetrics, UsageReport } from "@multiremi/contracts/usage-accounting";

export function usageMetrics(overrides: Partial<UsageMetrics> = {}): UsageMetrics {
  return { actual_input_tokens: 100, actual_output_tokens: 20, actual_cache_read_tokens: 10, actual_cache_write_tokens: 5,
    actual_unsplit_tokens: 15, actual_total_tokens: 150, unknown_task_count: 0, context_peak_tokens: 8000, task_count: 1,
    total_seconds: 60, known_cost_by_currency: { USD: 0.4 }, priced_tokens: 150, unpriced_tokens: 0, price_quality: "configured", complete: true,
    status_counts: { completed: 1, failed: 0, cancelled: 0, active: 0, queued: 0 }, ...overrides };
}
export function usageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  const summary = usageMetrics();
  return { summary, daily: [{ ...summary, date: "2026-10-01" }], by_agent: [{ ...summary, agent_id: "agent-old" }],
    by_model: [{ ...summary, provider: "codex", model: "retired-model", requested_model: "retired-model", model_source: "reported", model_provenance: "provider_reported", connection_id: "connection-old" }],
    by_runtime: [{ ...summary, runtime_id: "runtime-old", runtime_provenance: "live_task" }], task_daily: [{ date: "2026-10-01", task_count: 1, total_seconds: 60, status_counts: summary.status_counts }],
    time_basis: { consumption: "unit_occurred_at", terminal_tasks: "terminal_lifecycle_at", active_tasks: "current_snapshot" },
    coverage: { priced_tokens: 150, unpriced_tokens: 0, token_ratio: 1, unknown_task_count: 0 }, as_of: "2026-10-06T12:00:00.000Z", pricing_revision: "2",
    window: { since: null, until: null, days: null, tz: "UTC", project_id: null, runtime_id: null }, ...overrides };
}
