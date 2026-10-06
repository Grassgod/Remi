import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { SetUsagePriceInput, TaskUsageSnapshot, TaskUsageUnit, UsageMetrics } from "@multiremi/contracts/usage-accounting.js";
import { validateUsageSnapshot, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function unit(overrides: Partial<TaskUsageUnit> = {}): TaskUsageUnit {
  return { unitId: "request1", revision: 1, provider: "claude", model: "opus", modelSource: "provider_reported", scope: "request", source: "provider_request", accuracy: "exact",
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12,
    contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null,
    occurredAt: "2026-10-01T03:00:00.000Z", ...overrides };
}
const snapshot = (units: TaskUsageUnit[], overrides: Partial<TaskUsageSnapshot> = {}): TaskUsageSnapshot => ({
  version: 2, runId: "attempt1", revision: 1, complete: true, units, ...overrides,
});
function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "usage-runtime", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "accounting-worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "Account for work", workspaceId: "local", maxAttempts: 1 });
  store.claimTask(runtime.id);
  store.startTask(task.id);
  return { store, runtime, agent, task };
}
const price = (overrides: Partial<SetUsagePriceInput> = {}): SetUsagePriceInput => ({
  provider: "claude", model: "opus", connection_id: null, requested_model_alias: false, currency: "USD", input_per_million: 2,
  output_per_million: 10, cache_read_per_million: 0.2, cache_write_per_million: 3, unsplit_per_million: null,
  source: "configured", source_url: null, effective_from: "2026-09-01T00:00:00.000Z", effective_to: null, ...overrides,
});

describe("normalized task consumption", () => {
  it("serializes legacy snapshots when receipt clocks collide or move backwards", () => {
    const { store, task } = fixture();
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 10, outputTokens: 2 }]);
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 20, outputTokens: 3 }]);
      clock.mockReturnValue(500);
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 30, outputTokens: 4 }]);
      expect(store.getTask(task.id)?.usage).toMatchObject([{ inputTokens: 30, outputTokens: 4, totalTokens: 34 }]);
      expect(db!.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(task.id)).toEqual({ revision: 1002 });
    } finally { clock.mockRestore(); }
  });
  it("persists progress-summary purpose and separates helper/model rows without losing additive totals", () => {
    const { store, task } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit(), unit({ unitId: "helper", purpose: "progress_summary", inputTokens: 5, outputTokens: 1 })]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.actual_total_tokens).toBe(18);
    expect(report.by_model.map(row => [row.purpose, row.actual_total_tokens])).toEqual([["agent", 12], ["progress_summary", 6]]);
    expect(db!.query("SELECT purpose FROM multiremi_usage_units WHERE task_id=? AND unit_id='helper'").get(task.id)).toEqual({ purpose: "progress_summary" });
  });
  it.each(["empty", "context"])("keeps a completed %s run unknown alongside a fully measured run", (kind) => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    const context = unit({ source: "context_snapshot", scope: "turn", accuracy: "unknown", inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, contextTokens: 1000 });
    store.reportTaskUsageSnapshot(task.id, snapshot(kind === "empty" ? [] : [context], { runId: "unobserved-attempt" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 1, complete: false });
  });

  it("limits model lifecycle metrics to the same lifecycle window as summary", () => {
    const { store, task } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    db!.run("UPDATE multiremi_tasks SET status='completed',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-02T00:00:00Z' WHERE id=?", [task.id]);
    const report = store.getUsageReport({ workspaceId: "local", since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z" });
    expect(report.summary.status_counts.completed).toBe(0);
    expect(report.by_model[0]?.status_counts.completed).toBe(0);
    expect(report.by_model[0]?.total_seconds).toBe(0);
    expect(report.summary.actual_total_tokens).toBe(12);
  });

  it("checks unknown run coverage within the selected immutable runtime scope", () => {
    const { store, task, runtime } = fixture();
    store.setUsagePrice("local", price());
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    const other = store.registerRuntime({ name: "empty retry", provider: "claude", workspaceId: "local" });
    db!.run("UPDATE multiremi_tasks SET runtime_id=? WHERE id=?", [other.id, task.id]);
    store.reportTaskUsageSnapshot(task.id, snapshot([], { runId: "empty-on-other-runtime" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ unknown_task_count: 1, complete: false });
    expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: runtime.id }).summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 0, complete: true });
    expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: other.id }).summary).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 1, complete: false });
  });

  it("keeps an ambiguous reported-total request unknown alongside exact consumption in the same run", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    store.reportTaskUsageSnapshot(task.id, snapshot([unit(), unit({ unitId: "ambiguous-total", accuracy: "unknown", inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: 100 })]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 1, complete: false });
  });

  it("retains a failed helper's unknown attempt alongside exact main consumption", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    store.reportTaskUsageSnapshot(task.id, snapshot([unit(), unit({ unitId: "failed-helper", purpose: "progress_summary", accuracy: "unknown",
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null })]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 1, complete: false });
  });
  it("retains first-attempt historical task ownership as recorded evidence, while cross-switch records remain unknown", () => {
    const { store, task, runtime } = fixture();
    writeUsageSnapshot(db!, task.id, snapshot([unit()], { runId: "historical" }), { historical: true });
    expect(db!.query("SELECT runtime_id,runtime_provenance FROM multiremi_usage_units WHERE task_id=?").get(task.id)).toMatchObject({ runtime_id: runtime.id, runtime_provenance: "trace_owner" });
    expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: runtime.id }).summary.actual_total_tokens).toBe(12);
    db!.run("UPDATE multiremi_tasks SET attempt=2 WHERE id=?", [task.id]);
    writeUsageSnapshot(db!, task.id, snapshot([unit()], { runId: "ambiguous-history" }), { historical: true });
    expect(db!.query("SELECT runtime_id,runtime_provenance FROM multiremi_usage_units WHERE task_id=? AND run_id=?").get(task.id, "ambiguous-history")).toMatchObject({ runtime_id: null, runtime_provenance: "unknown" });
  });
  it("promotes a chunked final marker at the same revision without losing earlier units", () => {
    const { store, task } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()], { complete: false }));
    store.reportTaskUsageSnapshot(task.id, snapshot([], { complete: true }));
    store.reportTaskUsageSnapshot(task.id, snapshot([], { complete: false }));
    expect(db!.query("SELECT complete,revision FROM multiremi_usage_runs WHERE task_id=? AND run_id=?").get(task.id, "attempt1")).toEqual({ complete: 1, revision: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
  });
  it("freezes each run's runtime and project, including late replay after an execution moves", () => {
    const { store, task, runtime } = fixture();
    const secondRuntime = store.registerRuntime({ name: "second-attempt", provider: "claude", workspaceId: "local" });
    const firstProject = store.createProject({ title: "First project", workspaceId: "local" });
    const secondProject = store.createProject({ title: "Second project", workspaceId: "local" });
    const issue = store.createIssue({ title: "Execution project", projectId: firstProject.id, workspaceId: "local" });
    db!.run("UPDATE multiremi_tasks SET issue_id=? WHERE id=?", [issue.id, task.id]);
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ inputTokens: 10, outputTokens: 0 })]));
    db!.run("UPDATE multiremi_tasks SET runtime_id=? WHERE id=?", [secondRuntime.id, task.id]);
    db!.run("UPDATE multiremi_issues SET project_id=? WHERE id=?", [secondProject.id, issue.id]);
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ inputTokens: 20, outputTokens: 0 })], { runId: "attempt2" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ unitId: "late", inputTokens: 5, outputTokens: 0 })], { revision: 0 }));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.actual_total_tokens).toBe(35);
    expect(report.by_runtime.find(row => row.runtime_id === runtime.id)?.actual_total_tokens).toBe(15);
    expect(report.by_runtime.find(row => row.runtime_id === secondRuntime.id)?.actual_total_tokens).toBe(20);
    expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: runtime.id }).summary.actual_total_tokens).toBe(15);
    expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: secondRuntime.id }).summary.actual_total_tokens).toBe(20);
    expect(store.getUsageReport({ workspaceId: "local", days: null, projectId: firstProject.id }).summary.actual_total_tokens).toBe(15);
    expect(store.getUsageReport({ workspaceId: "local", days: null, projectId: secondProject.id }).summary.actual_total_tokens).toBe(20);
    expect(store.getUsageReport({ workspaceId: "local", days: null, projectId: firstProject.id }).summary.status_counts.active).toBe(0);
    expect(store.getUsageReport({ workspaceId: "local", days: null, projectId: secondProject.id }).summary.status_counts.active).toBe(1);
    expect(report.summary.task_count).toBe(1);
    expect(report.by_runtime.reduce((sum, row) => sum + row.task_count, 0)).toBe(2);
  });
  it("includes queued project tasks as unknown coverage without consuming usage or inventing a scope", () => {
    const store = createLocalStore();
    const project = store.createProject({ title: "Queued scope", workspaceId: "local" });
    const issue = store.createIssue({ title: "Pending", projectId: project.id, workspaceId: "local" });
    const agent = store.createAgent({ name: "Queued worker", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Wait", workspaceId: "local" });
    const report = store.getUsageReport({ workspaceId: "local", projectId: project.id, days: null });
    expect(report.summary).toMatchObject({ task_count: 1, unknown_task_count: 1, actual_total_tokens: 0, status_counts: { queued: 1 } });
    expect(db!.query("SELECT task_id FROM multiremi_usage_task_scopes WHERE task_id=?").get(task.id)).toBeNull();
  });
  it("replaces newer unit revisions, rejects conflicts, keeps distinct late units and sums retry attempts once", () => {
    const { store, task } = fixture();
    const initial = unit();
    store.reportTaskUsageSnapshot(task.id, snapshot([initial]));
    store.reportTaskUsageSnapshot(task.id, snapshot([initial]));
    const updated = unit({ revision: 2, inputTokens: 20, reportedTotalTokens: 22 });
    store.reportTaskUsageSnapshot(task.id, snapshot([updated], { revision: 10 }));
    store.reportTaskUsageSnapshot(task.id, snapshot([initial], { revision: 2, complete: false }));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ unitId: "late-child", model: "haiku", inputTokens: 5, outputTokens: 3, reportedTotalTokens: 8 })], { revision: 3 }));
    store.reportTaskUsageSnapshot(task.id, snapshot([initial], { runId: "attempt2" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 42, task_count: 1 });
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_units").get()).toEqual({ n: 3 });
    expect(() => store.reportTaskUsageSnapshot(task.id, snapshot([unit({ revision: 2, inputTokens: 99 })], { revision: 11 }))).toThrow("Conflicting usage unit");
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(42);
  });

  it.each(["failed", "cancelled"])("accepts actual usage arriving after task becomes %s", (status) => {
    const { store, task } = fixture();
    if (status === "failed") store.failTask(task.id, { error: "Provider interrupted" });
    else store.cancelTask(task.id);
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    expect(store.getTask(task.id)?.status).toBe(status);
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.actual_total_tokens).toBe(12);
    expect(report.summary.status_counts[status as "failed" | "cancelled"]).toBe(1);
  });

  it("reports context-only and absent telemetry as unknown consumption, while explicit actual zero remains known", () => {
    const { store, task } = fixture();
    const context = unit({ source: "context_snapshot", scope: "turn", model: null, accuracy: "unknown",
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null,
      reportedTotalTokens: null, contextTokens: 78048, contextWindow: 200000 });
    store.reportTaskUsageSnapshot(task.id, snapshot([context]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 1, context_peak_tokens: 78048, complete: false });
    expect(() => validateUsageSnapshot(snapshot([{ ...context, inputTokens: 1 }]))).toThrow("Context snapshots cannot contain actual usage");
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ unitId: "actual-zero", inputTokens: 0, outputTokens: 0, reportedTotalTokens: 0 })], { revision: 2 }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 0, complete: true });
  });

  it("preserves totals-only legacy observations as ambiguous evidence without inventing context or charges", () => {
    const { store, task } = fixture();
    store.reportTaskUsage(task.id, [{ provider: "codex", model: "gpt-model", inputTokens: 0, outputTokens: 0, totalTokens: 78048 }]);
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 0, context_peak_tokens: null, unknown_task_count: 1, complete: false });
    expect(db!.query("SELECT reported_total_tokens,context_tokens FROM multiremi_usage_units WHERE task_id=?").get(task.id)).toMatchObject({ reported_total_tokens: 78048, context_tokens: null });
  });

  it("retains all-zero detailed but nonzero actual total with source and uncertainty", () => {
    const { store, task } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ model: null, inputTokens: 0, outputTokens: 0,
      actualUnsplitTokens: 1200, reportedTotalTokens: 1200, accuracy: "unknown" })]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 1200, actual_unsplit_tokens: 1200, unknown_task_count: 1, unpriced_tokens: 1200, complete: false });
  });
});

describe("consumption price evidence", () => {
  it("separates published reference rates and SDK estimates from confirmed pricing", () => {
    const { store, task } = fixture();
    expect(() => validateUsageSnapshot(snapshot([unit({ costAmount: 1, costCurrency: "USD", costSource: "provider_reported", scope: "task" })]))).toThrow("request or turn scope");
    store.setUsagePrice("local", price({ source: "published", source_url: "https://example.com/catalog" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    let report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ priced_tokens: 0, unpriced_tokens: 12, known_cost_by_currency: {}, reference_cost_by_currency: { USD: 0.00004 }, complete: false });
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ revision: 2, costAmount: 0.25, costCurrency: "USD", costSource: "sdk_estimate" })], { revision: 2 }));
    report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ priced_tokens: 0, known_cost_by_currency: {}, reference_cost_by_currency: {}, sdk_estimate_cost_by_currency: { USD: 0.25 }, complete: false });
    // A separate monetary turn must not be added to the request's public-price
    // reference or counted as another request's consumption.
    store.reportTaskUsageSnapshot(task.id, snapshot([
      unit({ revision: 3 }),
      unit({ unitId: "sdk-money", costAmount: 0.25, costCurrency: "USD", costSource: "sdk_estimate", source: "provider_turn", scope: "turn", accuracy: "unknown",
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null }),
      unit({ unitId: "unknown-money", costAmount: 999, costCurrency: "USD", costSource: "unknown", source: "provider_turn", scope: "task", accuracy: "unknown",
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null }),
    ], { revision: 3 }));
    report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 0, known_cost_by_currency: {}, reference_cost_by_currency: { USD: 0.00004 }, sdk_estimate_cost_by_currency: { USD: 0.25 } });
  });
  it("permits configured channel prices for acknowledged request models but never applies published SKU rates to an alias", () => {
    const { store, task } = fixture();
    const connection = "runtime:rt-private:profile:claude";
    store.setUsagePrice("local", price({ model: "gateway-alias", connection_id: connection, requested_model_alias: true, input_per_million: 2, output_per_million: 0 }));
    store.setUsagePrice("local", price({ model: "gateway-alias", connection_id: "workspace:local:relay:claude", source: "published", source_url: "https://example.com/prices" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([
      unit({ unitId: "configured-request", model: null, requestedModel: "gateway-alias", modelSource: "session_acknowledged",
        connectionId: connection, inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 }),
      unit({ unitId: "published-alias", model: null, requestedModel: "gateway-alias", modelSource: "session_acknowledged",
        connectionId: "workspace:local:relay:claude", inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 }),
    ]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ known_cost_by_currency: { USD: 2 }, priced_tokens: 1_000_000, unpriced_tokens: 1_000_000 });
    expect(report.by_model.every(row => row.model === null && row.requested_model === "gateway-alias" && row.model_source === "requested")).toBe(true);
  });
  it("prices only exact provider/model/connection matches and treats explicit zero prices as known", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    store.setUsagePrice("local", price({ connection_id: "private-channel", input_per_million: 0, output_per_million: 0 }));
    store.reportTaskUsageSnapshot(task.id, snapshot([
      unit({ unitId: "public", inputTokens: 1_000_000, outputTokens: 100_000, reportedTotalTokens: 1_100_000 }),
      unit({ unitId: "private", connectionId: "private-channel", inputTokens: 1_000_000, outputTokens: 100_000, reportedTotalTokens: 1_100_000 }),
      unit({ unitId: "mismatch-provider", provider: "codex", inputTokens: 100, outputTokens: 0, reportedTotalTokens: 100 }),
      unit({ unitId: "mismatch-connection", connectionId: "unknown-channel", inputTokens: 100, outputTokens: 0, reportedTotalTokens: 100 }),
      unit({ unitId: "mismatch-model", model: null, inputTokens: 100, outputTokens: 0, reportedTotalTokens: 100 }),
    ]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ known_cost_by_currency: { USD: 3 }, priced_tokens: 2_200_000, unpriced_tokens: 300, complete: false });
    expect(report.by_model.find(row => row.connection_id === "private-channel")?.known_cost_by_currency).toEqual({ USD: 0 });
  });

  it("keeps currencies separate and selects price versions at each request's occurrence time", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price({ input_per_million: 2, output_per_million: 0 }));
    store.setUsagePrice("local", price({ effective_from: "2026-10-02T00:00:00.000Z", input_per_million: 4, output_per_million: 0 }));
    store.setUsagePrice("local", price({ model: "haiku", currency: "CNY", input_per_million: 6, output_per_million: 0 }));
    store.reportTaskUsageSnapshot(task.id, snapshot([
      unit({ unitId: "before", inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 }),
      unit({ unitId: "after", occurredAt: "2026-10-03T03:00:00.000Z", inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 }),
      unit({ unitId: "cny", model: "haiku", inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 }),
      unit({ unitId: "actual-cost", costAmount: 0.25, costCurrency: "EUR" }),
    ]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.known_cost_by_currency).toEqual({ USD: 6, CNY: 6, EUR: 0.25 });
    expect(report.summary.price_quality).toBe("mixed");
    expect(store.listUsagePrices("local").filter(row => row.model === "opus")).toHaveLength(2);
    expect(() => store.setUsagePrice("local", price({ effective_from: "2026-10-01T00:00:00.000Z", effective_to: "2026-10-03T00:00:00.000Z" }))).toThrow("overlap");
  });

  it("reconciles additive metrics across every dimension and buckets requests by actual day", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price({ output_per_million: 0 }));
    store.reportTaskUsageSnapshot(task.id, snapshot([
      unit({ unitId: "day1", inputTokens: 100, outputTokens: 0, reportedTotalTokens: 100, occurredAt: "2026-10-01T15:30:00.000Z" }),
      unit({ unitId: "day2", inputTokens: 200, outputTokens: 0, reportedTotalTokens: 200, occurredAt: "2026-10-01T16:30:00.000Z" }),
    ]));
    store.completeTask(task.id, { output: "done" });
    const report = store.getUsageReport({ workspaceId: "local", days: null, tz: "Asia/Shanghai" });
    expect(report.daily.map(row => [row.date, row.actual_total_tokens])).toEqual([["2026-10-01", 100], ["2026-10-02", 200]]);
    const sum = (rows: UsageMetrics[], key: keyof UsageMetrics) => rows.reduce((total, row) => total + Number(row[key]), 0);
    for (const rows of [report.daily, report.by_agent, report.by_model, report.by_runtime]) {
      for (const key of ["actual_total_tokens", "priced_tokens", "unpriced_tokens"] as const) expect(sum(rows, key)).toBe(report.summary[key]);
      expect(rows.reduce((amount, row) => amount + (row.known_cost_by_currency.USD ?? 0), 0)).toBeCloseTo(report.summary.known_cost_by_currency.USD!, 10);
    }
    expect(store.getUsageReport({ workspaceId: "local", days: null, since: "2026-10-01T16:00:00.000Z", until: "2026-10-02T16:00:00.000Z" }).summary.actual_total_tokens).toBe(200);
    expect(report.summary.task_count).toBe(1);
  });
});
