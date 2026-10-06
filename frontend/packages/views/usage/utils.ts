import type { UsageMetrics, UsageReport } from "@multiremi/contracts/usage-accounting";

export function formatKnownCost(metrics: UsageMetrics): string {
  const costs = Object.entries(metrics.known_cost_by_currency);
  if (!costs.length) return "—";
  return costs.sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" · ");
}
export function tokenCoverage(metrics: UsageMetrics): number | null {
  return metrics.actual_total_tokens > 0 ? metrics.priced_tokens / metrics.actual_total_tokens : null;
}
export function hasKnownTokens(metrics: UsageMetrics): boolean {
  return metrics.actual_total_tokens > 0 || metrics.unknown_task_count === 0;
}

export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function trendRows(report: UsageReport, weekly: boolean, currency: string) {
  const rows = new Map<string, { label: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; unsplit: number | null; cost: number | null; seconds: number; completed: number; failed: number; cancelled: number; active: number; queued: number }>();
  for (const day of report.daily) {
    const key = weekly ? weekStart(day.date) : day.date;
    const row = rows.get(key) ?? { label: key, input: null, output: null, cacheRead: null, cacheWrite: null, unsplit: null, cost: null, seconds: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0 };
    if (hasKnownTokens(day)) {
      row.input = (row.input ?? 0) + day.actual_input_tokens; row.output = (row.output ?? 0) + day.actual_output_tokens;
      row.cacheRead = (row.cacheRead ?? 0) + day.actual_cache_read_tokens; row.cacheWrite = (row.cacheWrite ?? 0) + day.actual_cache_write_tokens;
      row.unsplit = (row.unsplit ?? 0) + day.actual_unsplit_tokens;
    }
    if (currency in day.known_cost_by_currency) row.cost = (row.cost ?? 0) + day.known_cost_by_currency[currency]!;
    row.seconds += day.total_seconds;
    for (const s of ["completed", "failed", "cancelled", "active", "queued"] as const) row[s] += day.status_counts[s];
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Lifecycle counts use independent dates from consumption. */
export function taskTrendRows(report: UsageReport, weekly: boolean) {
  const rows = new Map<string, { label: string; seconds: number; completed: number; failed: number; cancelled: number; active: number; queued: number }>();
  for (const day of report.task_daily) {
    const label = weekly ? weekStart(day.date) : day.date;
    const row = rows.get(label) ?? { label, seconds: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0 };
    row.seconds += day.total_seconds;
    for (const status of ["completed", "failed", "cancelled", "active", "queued"] as const) row[status] += day.status_counts[status];
    rows.set(label, row);
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function usageCsv(rows: Array<{ key?: string; label: string; metrics: UsageMetrics; provider?: string; actualModel?: string | null; requested?: string | null; modelProvenance?: string; purpose?: string; connection?: string | null }>): string {
  const currencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.known_cost_by_currency)))].sort();
  const referenceCurrencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.reference_cost_by_currency ?? {})))].sort();
  const sdkCurrencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.sdk_estimate_cost_by_currency ?? {})))].sort();
  const escape = (value: string | number | boolean | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const fields = ["actual_total_tokens", "actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "context_peak_tokens", "priced_tokens", "unpriced_tokens", "unknown_task_count", "task_count"] as const;
  return [["group", "group_key", "provider", "actual_model", "requested_model", "model_provenance", "purpose", "connection_id", "cost_allocation_complete", ...fields, ...currencies.map(currency => `known_cost_${currency}`), ...referenceCurrencies.map(currency => `reference_cost_${currency}`), ...sdkCurrencies.map(currency => `sdk_estimate_cost_${currency}`)], ...rows.map(({ key, label, metrics, provider, actualModel, requested, modelProvenance, purpose, connection }) => [label, key ?? null, provider ?? null, actualModel ?? null, requested ?? null, modelProvenance ?? null, purpose ?? null, connection ?? null, metrics.cost_allocation_complete !== false,
    ...fields.map(field => field.startsWith("actual_") && !hasKnownTokens(metrics) ? null : metrics[field]),
    ...currencies.map(currency => metrics.known_cost_by_currency[currency] ?? null), ...referenceCurrencies.map(currency => metrics.reference_cost_by_currency?.[currency] ?? null), ...sdkCurrencies.map(currency => metrics.sdk_estimate_cost_by_currency?.[currency] ?? null)])].map(row => row.map(escape).join(",")).join("\r\n");
}
