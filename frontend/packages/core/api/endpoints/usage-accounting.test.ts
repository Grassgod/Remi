import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageAccountingEndpoints } from "./usage-accounting";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { usageMetrics, usageReport } from "../../usage/test-fixtures";

afterEach(() => vi.unstubAllGlobals());
function mock(body: unknown) { const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetch); return fetch; }
describe("Usage accounting response boundary", () => {
  it("preserves historical time attribution and identity-conflict coverage", async () => {
    const report = usageReport({ summary: usageMetrics({ task_attributed_tokens: 150, task_attributed_task_count: 1, time_provenance: "task_attributed", identity_conflict_task_count: 1, complete: false }) });
    report.time_basis.historical_aggregates = "task_attribution_at";
    mock(report);
    const parsed = await new UsageAccountingEndpoints(new HttpClient("https://api.example.test")).getUsageReport("ws", { tz: "UTC" });
    expect(parsed.summary).toMatchObject({ task_attributed_tokens: 150, task_attributed_task_count: 1, time_provenance: "task_attributed", identity_conflict_task_count: 1 });
    expect(parsed.time_basis.historical_aggregates).toBe("task_attribution_at");
  });
  it("preserves unknown context-only usage and sends workspace, history and both filters", async () => {
    const metrics = usageMetrics({ actual_input_tokens: 0, actual_output_tokens: 0, actual_cache_read_tokens: 0, actual_cache_write_tokens: 0, actual_unsplit_tokens: 0, actual_total_tokens: 0,
      unknown_task_count: 1, priced_tokens: 0, unpriced_tokens: 0, known_cost_by_currency: {}, complete: false });
    const fetch = mock(usageReport({ summary: metrics, daily: [] }));
    const api = new UsageAccountingEndpoints(new HttpClient("https://api.example.test"));
    const report = await api.getUsageReport("ws-1", { days: "all", tz: "Asia/Shanghai", project_id: "p-1", runtime_id: "r-1" });
    expect(report.summary).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 1, context_peak_tokens: 8000, known_cost_by_currency: {} });
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ workspace_id: "ws-1", days: "all", tz: "Asia/Shanghai", project_id: "p-1", runtime_id: "r-1" });
  });
  it.each(["missing", "negative", "inconsistent"])("rejects %s metrics instead of rendering fabricated zeros", async (kind) => {
    const report = usageReport();
    const summary: Record<string, unknown> = { ...report.summary };
    if (kind === "missing") delete summary.actual_input_tokens;
    if (kind === "negative") summary.actual_input_tokens = -1;
    if (kind === "inconsistent") summary.actual_total_tokens = 1;
    mock({ ...report, summary });
    await expect(new UsageAccountingEndpoints(new HttpClient("https://api.example.test")).getUsageReport("ws", { tz: "UTC" })).rejects.toBeInstanceOf(ApiContractError);
  });
  it("keeps explicit zero cost distinct from a missing price and preserves currencies", async () => {
    const report = usageReport({ summary: usageMetrics({ known_cost_by_currency: { USD: 0, CNY: 2 } }) });
    mock(report);
    expect((await new UsageAccountingEndpoints(new HttpClient("https://api.example.test")).getUsageReport("ws", { tz: "UTC" })).summary.known_cost_by_currency).toEqual({ USD: 0, CNY: 2 });
  });
});
