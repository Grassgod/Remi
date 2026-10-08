import type { UsageMetrics, UsageReport } from "@multiremi/contracts/usage-accounting";

export type ValueState = "known" | "subtotal" | "unknown" | "empty";
export interface NullableValue { value: number | null; state: ValueState }
export type UsageMetric = "tokens" | "cost" | "tasks" | "time";
export type ConsumptionMetrics = Omit<UsageMetrics, "total_seconds" | "status_counts">;
export interface CalendarWindow { since?: string; until: string }
export interface UsageCalendarWindows {
  current: CalendarWindow; previous: CalendarWindow | null; heatmap: CalendarWindow;
  today: string; heatmapStart: string; tz: string; asOf: string;
}

export function nullableValue(metrics: ConsumptionMetrics & Partial<Pick<UsageMetrics, "total_seconds">>, metric: UsageMetric, currency = "USD"): NullableValue {
  if (metric === "cost") {
    const value = metrics.known_cost_by_currency[currency];
    if (value !== undefined) return { value, state: metrics.complete && metrics.cost_allocation_complete !== false ? "known" : "subtotal" };
    return { value: null, state: metrics.task_count === 0 && metrics.actual_total_tokens === 0 && metrics.unknown_task_count === 0 ? "empty" : "unknown" };
  }
  if (metric === "tokens") {
    if (metrics.unknown_task_count > 0) return { value: metrics.actual_total_tokens > 0 ? metrics.actual_total_tokens : null, state: metrics.actual_total_tokens > 0 ? "subtotal" : "unknown" };
    return { value: metrics.actual_total_tokens, state: metrics.task_count === 0 ? "empty" : "known" };
  }
  return { value: metric === "tasks" ? metrics.task_count : metrics.total_seconds ?? null, state: metrics.task_count === 0 ? "empty" : "known" };
}
export function formatKnownCost(metrics: ConsumptionMetrics): string {
  const costs = Object.entries(metrics.known_cost_by_currency);
  return costs.length ? costs.sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(" · ") : "—";
}
export function tokenCoverage(metrics: ConsumptionMetrics): number | null { return metrics.actual_total_tokens > 0 ? metrics.priced_tokens / metrics.actual_total_tokens : null; }
export function hasKnownTokens(metrics: ConsumptionMetrics): boolean { return metrics.actual_total_tokens > 0 || metrics.unknown_task_count === 0; }
export function modelKey(row: UsageReport["by_model"][number] | NonNullable<UsageReport["day_model"]>["rows"][number]): string {
  return JSON.stringify([row.provider, row.model, row.requested_model, row.model_provenance, row.purpose ?? "agent", row.connection_id]);
}
export function addDays(date: string, days: number): string { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }
export function dateInTimezone(asOf: string, tz: string): string {
  if (!Number.isFinite(Date.parse(asOf))) throw new RangeError("Invalid accounting timestamp");
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(asOf));
}
/** Search actual local-day boundaries: DST midnight changes do not imply 24-hour days. */
export function localDayStart(date: string, tz: string): string {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let low = midnight - 36 * 3_600_000, high = midnight + 36 * 3_600_000;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (dateInTimezone(new Date(mid).toISOString(), tz) < date) low = mid; else high = mid; }
  return new Date(high).toISOString();
}
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return day.toISOString().slice(0, 10);
}
export function calendarWindows(asOf: string, tz: string, days: number | "all"): UsageCalendarWindows {
  if (days !== "all" && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) throw new RangeError("Invalid calendar window");
  const today = dateInTimezone(asOf, tz), endDate = addDays(today, 1), until = localDayStart(endDate, tz);
  const startDate = days === "all" ? null : addDays(today, -(days - 1));
  const heatmapStart = addDays(weekStart(today), -25 * 7);
  return { current: { ...(startDate ? { since: localDayStart(startDate, tz) } : {}), until },
    previous: startDate && days !== "all" ? { since: localDayStart(addDays(startDate, -days), tz), until: localDayStart(startDate, tz) } : null,
    heatmap: { since: localDayStart(heatmapStart, tz), until }, today, heatmapStart, tz, asOf };
}

export function compareCost(current: UsageReport, previous: UsageReport, currency: string): number | null {
  const a = nullableValue(current.summary, "cost", currency), b = nullableValue(previous.summary, "cost", currency);
  if (a.state !== "known" || b.state !== "known" || a.value === null || b.value === null || b.value <= 0
    || current.pricing_revision !== previous.pricing_revision || current.summary.price_quality !== previous.summary.price_quality
    || !["provider_reported", "configured"].includes(current.summary.price_quality)
    || current.window.tz !== previous.window.tz || current.window.project_id !== previous.window.project_id || current.window.runtime_id !== previous.window.runtime_id
    || current.window.since === null || previous.window.since === null || current.window.until === null || current.window.since !== previous.window.until) return null;
  const calendarSpan = (report: UsageReport) => Date.parse(`${dateInTimezone(report.window.until!, report.window.tz)}T00:00:00Z`) - Date.parse(`${dateInTimezone(report.window.since!, report.window.tz)}T00:00:00Z`);
  if (calendarSpan(current) <= 0 || calendarSpan(current) !== calendarSpan(previous)) return null;
  return (a.value - b.value) / b.value * 100;
}

export interface TrendRow {
  label: string; date: string; weekStart: string; rangeLabel: string; partial: boolean; daysCovered: number; state: ValueState;
  input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; unsplit: number | null;
  cost: number | null; costState: ValueState; tokenState: ValueState; seconds: number;
  completed: number; failed: number; cancelled: number; active: number; queued: number;
}
function combinedState(states: ValueState[]): ValueState {
  if (states.every(s => s === "empty")) return "empty";
  if (states.every(s => s === "unknown" || s === "empty")) return "unknown";
  return states.some(s => s === "unknown" || s === "subtotal") ? "subtotal" : "known";
}
function dateDecoration(date: string, report: UsageReport, weekly: boolean) {
  const today = dateInTimezone(report.as_of, report.window.tz), first = report.window.since ? dateInTimezone(report.window.since, report.window.tz) : date;
  const last = report.window.until ? dateInTimezone(new Date(Date.parse(report.window.until) - 1).toISOString(), report.window.tz) : today;
  const end = weekly ? addDays(date, 6) : date, coveredFirst = first > date ? first : date, coveredLast = last < today ? last : today;
  const coveredEnd = coveredLast < end ? coveredLast : end;
  return { date, weekStart: weekStart(date), rangeLabel: weekly ? `${date} – ${end}` : date,
    partial: weekly ? coveredFirst > date || coveredEnd < end : date === today,
    daysCovered: Math.max(0, Math.round((Date.parse(`${coveredEnd}T00:00:00Z`) - Date.parse(`${coveredFirst}T00:00:00Z`)) / 86_400_000) + 1) };
}
export function trendRows(report: UsageReport, weekly: boolean, currency: string): TrendRow[] {
  const grouped = new Map<string, UsageReport["daily"]>();
  for (const day of report.daily) { const key = weekly ? weekStart(day.date) : day.date; grouped.set(key, [...(grouped.get(key) ?? []), day]); }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([label, days]) => {
    const tokenState = combinedState(days.map(day => nullableValue(day, "tokens").state)), costState = combinedState(days.map(day => nullableValue(day, "cost", currency).state));
    const known = days.filter(hasKnownTokens), sum = (key: "actual_input_tokens" | "actual_output_tokens" | "actual_cache_read_tokens" | "actual_cache_write_tokens" | "actual_unsplit_tokens") => known.length ? known.reduce((n, day) => n + day[key], 0) : null;
    const amounts = days.flatMap(day => currency in day.known_cost_by_currency ? [day.known_cost_by_currency[currency]!] : []);
    return { label, ...dateDecoration(label, report, weekly), input: sum("actual_input_tokens"), output: sum("actual_output_tokens"), cacheRead: sum("actual_cache_read_tokens"), cacheWrite: sum("actual_cache_write_tokens"), unsplit: sum("actual_unsplit_tokens"),
      cost: amounts.length ? amounts.reduce((a, b) => a + b, 0) : null, state: tokenState, costState, tokenState,
      seconds: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0 };
  });
}
export interface TaskTrendRow { label: string; date: string; weekStart: string; rangeLabel: string; partial: boolean; daysCovered: number; seconds: number; taskCount: number; completed: number; failed: number; cancelled: number; active: number; queued: number }
export function taskTrendRows(report: UsageReport, weekly: boolean): TaskTrendRow[] {
  const rows = new Map<string, TaskTrendRow>();
  for (const day of report.task_daily) {
    const label = weekly ? weekStart(day.date) : day.date, row = rows.get(label) ?? { label, ...dateDecoration(label, report, weekly), seconds: 0, taskCount: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0 };
    row.seconds += day.total_seconds; row.taskCount += day.task_count;
    for (const status of ["completed", "failed", "cancelled", "active", "queued"] as const) row[status] += day.status_counts[status];
    rows.set(label, row);
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}
export interface HeatmapRow extends NullableValue { date: string; future: boolean; week: number; dayOfWeek: number }
export function heatmapRows(report: UsageReport, windows: UsageCalendarWindows, currency: string): HeatmapRow[] {
  const days = new Map(report.daily.map(day => [day.date, day]));
  return Array.from({ length: 26 * 7 }, (_, index) => {
    const date = addDays(windows.heatmapStart, index), future = date > windows.today, metrics = days.get(date);
    return { date, future, week: Math.floor(index / 7), dayOfWeek: index % 7, ...(future || !metrics ? { value: null, state: "empty" as const } : nullableValue(metrics, "cost", currency)) };
  });
}

/** Empty monetary buckets and unknown consumption stay blank in exports. */
export function usageCsv(rows: Array<{ key?: string; label: string; metrics: UsageMetrics; provider?: string; actualModel?: string | null; requested?: string | null; modelProvenance?: string; purpose?: string; connection?: string | null }>): string {
  const currencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.known_cost_by_currency)))].sort();
  const referenceCurrencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.reference_cost_by_currency ?? {})))].sort();
  const sdkCurrencies = [...new Set(rows.flatMap(row => Object.keys(row.metrics.sdk_estimate_cost_by_currency ?? {})))].sort();
  const escape = (value: string | number | boolean | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const fields = ["actual_total_tokens", "actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens", "actual_unsplit_tokens", "context_peak_tokens", "priced_tokens", "unpriced_tokens", "unknown_task_count", "task_count"] as const;
  return [["group", "group_key", "provider", "actual_model", "requested_model", "model_provenance", "purpose", "connection_id", "cost_allocation_complete", "time_provenance", "task_attributed_tokens", "task_attributed_task_count", "identity_conflict_task_count", ...fields, ...currencies.map(currency => `known_cost_${currency}`), ...referenceCurrencies.map(currency => `reference_cost_${currency}`), ...sdkCurrencies.map(currency => `sdk_estimate_cost_${currency}`)], ...rows.map(({ key, label, metrics, provider, actualModel, requested, modelProvenance, purpose, connection }) => [label, key ?? null, provider ?? null, actualModel ?? null, requested ?? null, modelProvenance ?? null, purpose ?? null, connection ?? null, metrics.cost_allocation_complete !== false,
    metrics.time_provenance ?? null, metrics.task_attributed_tokens ?? null, metrics.task_attributed_task_count ?? null, metrics.identity_conflict_task_count ?? null,
    ...fields.map(field => field.startsWith("actual_") && !hasKnownTokens(metrics) ? null : metrics[field]),
    ...currencies.map(currency => metrics.known_cost_by_currency[currency] ?? null), ...referenceCurrencies.map(currency => metrics.reference_cost_by_currency?.[currency] ?? null), ...sdkCurrencies.map(currency => metrics.sdk_estimate_cost_by_currency?.[currency] ?? null)])].map(row => row.map(escape).join(",")).join("\r\n");
}
