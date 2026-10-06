import { describe, expect, it } from "vitest";
import { usageMetrics, usageReport } from "./test-fixtures";
import { formatKnownCost, hasKnownTokens, tokenCoverage, trendRows, taskTrendRows, usageCsv } from "./utils";

describe("Usage presentation", () => {
  it("keeps lifecycle trends separate from cross-day consumption and exports unknowns as blanks", () => {
    const report = usageReport({ task_daily: [{ date: "2026-10-03", task_count: 1, total_seconds: 120, status_counts: { completed: 0, failed: 1, cancelled: 0, active: 0, queued: 0 } }] });
    expect(taskTrendRows(report, false)).toEqual([{ label: "2026-10-03", seconds: 120, completed: 0, failed: 1, cancelled: 0, active: 0, queued: 0 }]);
    expect(trendRows(report, false, "USD")[0]?.label).toBe("2026-10-01");
    const csv = usageCsv([{ label: 'retired,"model', metrics: report.summary }]);
    expect(csv).toContain('"retired,""model"');
    expect(csv).toContain('"known_cost_USD"');
    expect(csv).toContain('"cost_allocation_complete"');
    expect(csv).toContain('"0.4"');
  });
  it("keeps actual unsplit additive and context separate from actual totals", () => {
    const report = usageReport();
    const row = trendRows(report, false, "USD")[0]!;
    expect(row.input! + row.output! + row.cacheRead! + row.cacheWrite! + row.unsplit!).toBe(150);
    expect(report.summary.context_peak_tokens).toBe(8000);
  });
  it("shows no measured zero for context-only unknown consumption", () => {
    const metrics = usageMetrics({ actual_input_tokens: 0, actual_output_tokens: 0, actual_cache_read_tokens: 0, actual_cache_write_tokens: 0, actual_unsplit_tokens: 0, actual_total_tokens: 0, unknown_task_count: 1, known_cost_by_currency: {}, priced_tokens: 0, unpriced_tokens: 0, complete: false });
    expect(hasKnownTokens(metrics)).toBe(false);
    expect(formatKnownCost(metrics)).toBe("—");
    expect(tokenCoverage(metrics)).toBeNull();
    expect(trendRows(usageReport({ daily: [{ ...metrics, date: "2026-10-01" }] }), false, "USD")[0]?.input).toBeNull();
  });
  it("preserves zero prices and separates known subtotals in multiple currencies", () => {
    expect(formatKnownCost(usageMetrics({ known_cost_by_currency: { USD: 0, CNY: 2.5 } }))).toBe("CNY 2.50 · USD 0.00");
    expect(tokenCoverage(usageMetrics({ priced_tokens: 75, unpriced_tokens: 75 }))).toBe(0.5);
  });
  it("folds known costs and actual tokens across weeks without re-pricing model strings", () => {
    const report = usageReport();
    report.daily.push({ ...usageMetrics({ known_cost_by_currency: { USD: 0.6, CNY: 10 } }), date: "2026-10-03" });
    const row = trendRows(report, true, "USD")[0]!;
    expect(row.label).toBe("2026-09-28"); expect(row.cost).toBe(1); expect(row.unsplit).toBe(30);
  });
});
