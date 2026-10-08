import { describe, expect, it } from "vitest";
import { usageMetrics, usageReport } from "./test-fixtures";
import { calendarWindows, compareCost, heatmapRows, modelKey, nullableValue, taskTrendRows, trendRows, usageCsv } from "./view-model";

describe("canonical usage projections", () => {
  it("distinguishes recorded zero, unknown, known subtotal and absent activity", () => {
    const unknown = usageMetrics({ actual_total_tokens: 0, unknown_task_count: 1, known_cost_by_currency: {}, complete: false });
    expect(nullableValue(unknown, "tokens")).toEqual({ value: null, state: "unknown" });
    expect(nullableValue(unknown, "cost")).toEqual({ value: null, state: "unknown" });
    expect(nullableValue(usageMetrics({ unknown_task_count: 1, complete: false }), "tokens")).toEqual({ value: 150, state: "subtotal" });
    expect(nullableValue(usageMetrics({ known_cost_by_currency: { USD: 0 } }), "cost")).toEqual({ value: 0, state: "known" });
    expect(nullableValue(usageMetrics({ task_count: 0, actual_total_tokens: 0, known_cost_by_currency: {} }), "cost")).toEqual({ value: null, state: "empty" });
    expect(nullableValue(usageMetrics({ reference_cost_by_currency: { USD: 20 }, sdk_estimate_cost_by_currency: { USD: 9 }, known_cost_by_currency: {} }), "cost").value).toBeNull();
  });
  it("uses actual IANA boundaries over a DST transition and adjacent equal calendar periods", () => {
    const w = calendarWindows("2026-03-08T18:00:00Z", "America/New_York", 1);
    expect(w.current).toEqual({ since: "2026-03-08T05:00:00.000Z", until: "2026-03-09T04:00:00.000Z" });
    expect(w.previous).toEqual({ since: "2026-03-07T05:00:00.000Z", until: "2026-03-08T05:00:00.000Z" });
    const long = calendarWindows("2026-10-08T12:00:00Z", "Asia/Shanghai", 180);
    expect(long.previous?.until).toBe(long.current.since);
    expect((Date.parse(long.current.since!) - Date.parse(long.previous!.since!)) / 86_400_000).toBe(180);
    expect(calendarWindows("2026-10-08T12:00:00Z", "UTC", "all").previous).toBeNull();
  });
  it("builds exactly 26 Monday-first heatmap weeks without calling a missing day zero", () => {
    const windows = calendarWindows("2026-01-01T12:00:00Z", "UTC", 30);
    const report = usageReport({ as_of: windows.asOf, daily: [{ ...usageMetrics({ known_cost_by_currency: { USD: 0 } }), date: "2026-01-01" }] });
    const rows = heatmapRows(report, windows, "USD");
    expect(rows).toHaveLength(182);
    expect(rows[0]).toMatchObject({ date: "2025-07-07", week: 0, dayOfWeek: 0, value: null, state: "empty" });
    expect(rows.find(row => row.date === "2026-01-01")).toMatchObject({ state: "known", value: 0, future: false });
    expect(rows.find(row => row.date === "2026-01-02")).toMatchObject({ value: null, future: true });
  });
  it("keeps lifecycle dates separate, partial weeks bounded, and unsplit additive", () => {
    const report = usageReport({ as_of: "2026-10-08T12:00:00Z", window: { since: "2026-10-01T00:00:00Z", until: "2026-10-09T00:00:00Z", days: 8, tz: "UTC", project_id: null, runtime_id: null },
      task_daily: [{ date: "2026-10-07", task_count: 1, total_seconds: 180, status_counts: { completed: 0, failed: 1, cancelled: 0, active: 0, queued: 0 } }] });
    const tokens = trendRows(report, true, "USD");
    expect(tokens[0]).toMatchObject({ label: "2026-09-28", partial: true, daysCovered: 4, cost: 0.4, seconds: 0 });
    expect(tokens[0]!.input! + tokens[0]!.output! + tokens[0]!.cacheRead! + tokens[0]!.cacheWrite! + tokens[0]!.unsplit!).toBe(150);
    expect(taskTrendRows(report, false)[0]).toMatchObject({ date: "2026-10-07", seconds: 180, failed: 1, taskCount: 1 });
    expect(report.summary.context_peak_tokens).toBe(8000);
  });
  it("compares only known same-scope same-source same-price adjacent currency amounts", () => {
    const current = usageReport({ window: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z", days: 7, tz: "UTC", project_id: null, runtime_id: null } });
    const previous = usageReport({ summary: usageMetrics({ known_cost_by_currency: { USD: 0.2 } }), window: { ...current.window, since: "2026-09-24T00:00:00Z", until: current.window.since } });
    expect(compareCost(current, previous, "USD")).toBe(100);
    for (const other of [usageReport({ ...previous, pricing_revision: "changed" }), usageReport({ ...previous, summary: usageMetrics({ complete: false }) }),
      usageReport({ ...previous, summary: usageMetrics({ known_cost_by_currency: { USD: 0 } }) }), usageReport({ ...previous, summary: usageMetrics({ price_quality: "provider_reported" }) })]) expect(compareCost(current, other, "USD")).toBeNull();
    expect(compareCost(current, previous, "CNY")).toBeNull();
  });
  it("keeps routing/model/purpose identities separate and CSV monetary sources separate", () => {
    const model = usageReport().by_model[0]!;
    expect(modelKey(model)).not.toBe(modelKey({ ...model, purpose: "progress_summary" }));
    expect(modelKey(model)).not.toBe(modelKey({ ...model, connection_id: "different" }));
    const csv = usageCsv([{ label: "requested-only", metrics: usageMetrics({ known_cost_by_currency: {}, reference_cost_by_currency: { USD: 9 }, sdk_estimate_cost_by_currency: { CNY: 2 } }), requested: "gateway-model", modelProvenance: "session_acknowledged" }]);
    expect(csv).toContain('"reference_cost_USD","sdk_estimate_cost_CNY"');
    expect(csv).not.toContain('"known_cost_USD"');
  });
});
