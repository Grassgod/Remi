import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import type { SetUsagePriceInput, TaskUsageSnapshot, TaskUsageUnit, UsageMetrics } from "@multiremi/contracts/usage-accounting.js";
import { migrateLegacyUsage, validateUsageSnapshot, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { MultiremiStore } from "@multiremi/store.js";
import { assertRequestChargeIdentity, assertUsageIdentityBoundaries } from "./usage-accounting-boundary-cases.js";

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
  it("preserves reported floating-point amounts when transporting aggregate rows", () => {
    const { store, task } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ costAmount: Math.PI, costCurrency: "USD", costSource: "provider_reported" })]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.known_cost_by_currency.USD).toBe(Math.PI);
    expect(report.by_model[0]!.known_cost_by_currency.USD).toBe(Math.PI);
  });
  it("computes many diagnostic units once for all views without repeated run-evidence lookups", () => {
    const { store, task, runtime } = fixture();
    store.reportTaskUsageSnapshot(task.id, snapshot([unit()]));
    const context = unit({ unitId: "context", scope: "turn", source: "context_snapshot", accuracy: "unknown",
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, contextTokens: 70_000 });
    store.reportTaskUsageSnapshot(task.id, snapshot([context], { runId: "diagnostic-only" }));
    db!.run(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<12000)
      INSERT INTO multiremi_usage_units(task_id,run_id,unit_id,revision,workspace_id,agent_id,runtime_id,provider,scope,source,accuracy,occurred_at)
      SELECT task_id,run_id,'diagnostic:'||n,revision,workspace_id,agent_id,runtime_id,provider,scope,source,accuracy,occurred_at
      FROM multiremi_usage_units CROSS JOIN numbers WHERE task_id=? AND run_id='diagnostic-only' AND unit_id='context'`, [task.id]);
    const originalQuery = db!.query.bind(db!);
    const factQueries: string[] = [];
    const query = spyOn(db!, "query").mockImplementation(sql => {
      if (sql.startsWith("WITH tasks")) factQueries.push(sql);
      return originalQuery(sql);
    });
    const started = performance.now();
    const report = store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null });
    const elapsed = performance.now() - started;
    query.mockRestore();
    expect(report.summary).toMatchObject({ actual_total_tokens: 12, unknown_task_count: 1, context_peak_tokens: 70_000, complete: false });
    expect(factQueries).toHaveLength(1);
    expect(factQueries[0]).toContain("facts AS MATERIALIZED");
    expect(factQueries[0]).not.toContain("NOT EXISTS(SELECT 1 FROM multiremi_usage_units observed");
    expect(elapsed).toBeLessThan(5000);
    for (const rows of [report.daily, report.by_model, report.by_agent, report.by_runtime]) expect(rows.reduce((sum, row) => sum + row.actual_total_tokens, 0)).toBe(12);
  }, 20_000);
  it("retains parked revision floors and established owner facts across replay and store restart", () => {
    const { store, task, agent, runtime } = fixture();
    const other = store.createTask({ agentId: agent.id, prompt: "Parked duplicate", workspaceId: "local" });
    assertUsageIdentityBoundaries(store, db!, task.id, other.id, runtime.id, "sqlite-boundaries", () => new MultiremiStore(db!));
  });
  for (const order of ["money-first", "tokens-first", "identity-later"] as const) it(`checks request charge identity with ${order} arrival`, () => {
    const { store, task, runtime } = fixture();
    assertRequestChargeIdentity(store, task.id, runtime.id, `sqlite-price-${order}`, order, () => new MultiremiStore(db!));
  });
  it("keeps one canonical native request across tasks and retry runs, including separate charge evidence", () => {
    const { store, task, agent } = fixture();
    const other = store.createTask({ agentId: agent.id, prompt: "Duplicate archive owner", workspaceId: "local" });
    const tokens = unit({ providerSessionId: "native-session", providerRequestId: "message-123", connectionId: "route" });
    const money = unit({ ...tokens, unitId: "charge", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown", costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported", coveredUnitIds: [tokens.unitId] });
    store.reportTaskUsageSnapshot(task.id, snapshot([tokens, money]));
    store.reportTaskUsageSnapshot(other.id, snapshot([tokens, money]));
    store.reportTaskUsageSnapshot(other.id, snapshot([tokens, money]));
    store.reportTaskUsageSnapshot(task.id, snapshot([tokens], { runId: "retry" }));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 12, known_cost_by_currency: { USD: 0.25 }, identity_conflict_task_count: 2, complete: false });
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_usage_identity_conflicts").get()).toEqual({ n: 3 });
    const audit = db!.query("SELECT unit_json,owner_task_id FROM multiremi_usage_identity_conflicts WHERE task_id=? AND unit_id=?").get(other.id, tokens.unitId) as { unit_json: string; owner_task_id: string };
    expect(JSON.parse(audit.unit_json)).toMatchObject({ providerSessionId: "native-session", providerRequestId: "message-123", inputTokens: 10 });
    expect(audit.owner_task_id).toBe(task.id);
    expect(() => validateUsageSnapshot(snapshot([unit({ ...tokens, source: "context_snapshot" })]))).toThrow("provider identity");
  });
  it("treats a missing connection as competing evidence but preserves distinct confirmed routes", () => {
    const { store, task } = fixture();
    const tokens = unit({ providerSessionId: "session", providerRequestId: "short-id", connectionId: "route-a" });
    store.reportTaskUsageSnapshot(task.id, snapshot([tokens]));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ ...tokens, connectionId: "route-b" })], { runId: "distinct-route" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ ...tokens, connectionId: null })], { runId: "unknown-route" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 24, identity_conflict_task_count: 1, complete: false });
    expect(db!.query("SELECT owner_run_id FROM multiremi_usage_identity_conflicts ORDER BY owner_run_id").all()).toEqual([{ owner_run_id: "attempt1" }, { owner_run_id: "distinct-route" }]);
  });
  it("rejects overlapping cross-run cumulative intervals while retaining adjacent checkpoints", () => {
    const { store, task } = fixture();
    const vector = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: n });
    const meter = (id: string, before: number, after: number, epochId = "initial") => unit({ unitId: id, provider: "codex", providerSessionId: "thread", identityKind: "cumulative_meter",
      providerObservationId: id, meterEvidence: { epochId, before: vector(before), after: vector(after) }, inputTokens: after - before, outputTokens: 0, reportedTotalTokens: after - before });
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("a", 0, 100), meter("b", 100, 200)]));
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("c", 0, 300)], { runId: "reset-local-baseline" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 200, identity_conflict_task_count: 1, complete: false });
    expect(db!.query("SELECT owner_unit_id FROM multiremi_usage_identity_conflicts WHERE unit_id='c' ORDER BY owner_unit_id").all()).toEqual([{ owner_unit_id: "a" }, { owner_unit_id: "b" }]);
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("d", 200, 300)], { runId: "verified-next" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("e", 0, 50, "explicit-reset")], { runId: "verified-epoch" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(350);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_usage_meter_owners").get()).toEqual({ n: 4 });
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("f", 0, 50, "compaction-item:upstream-marker")], { runId: "live-compaction" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([meter("g", 0, 50, "compaction-timestamp:2026-10-01T03:00:00Z")], { runId: "native-compaction" }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(400);
  });
  it("labels historical aggregate dates as task attribution rather than fabricating request times", () => {
    const { store, task } = fixture();
    db!.run("UPDATE multiremi_tasks SET status='completed',started_at='2026-10-01T23:30:00Z',completed_at='2026-10-02T00:30:00Z',usage=? WHERE id=?", [JSON.stringify([{ provider: "claude", model: "old", inputTokens: 100, outputTokens: 2 }]), task.id]);
    migrateLegacyUsage(db!);
    store.reportTaskUsageSnapshot(task.id, snapshot([unit({ inputTokens: 5, outputTokens: 0, reportedTotalTokens: 5, occurredAt: "2026-10-01T23:40:00Z", timeProvenance: "provider_timestamp" })]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.daily.map(row => [row.date, row.actual_total_tokens, row.time_provenance])).toEqual([["2026-10-01", 5, "provider_timestamp"], ["2026-10-02", 102, "task_attributed"]]);
    expect(report.summary).toMatchObject({ actual_total_tokens: 107, task_attributed_tokens: 102, task_attributed_task_count: 1, time_provenance: "mixed" });
    expect(report.time_basis.historical_aggregates).toBe("task_attribution_at");
  });
  it("serializes legacy snapshots when receipt clocks collide or move backwards", () => {
    const { store, task } = fixture();
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 10, outputTokens: 2 }]);
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 20, outputTokens: 3 }]);
      clock.mockReturnValue(500);
      store.reportTaskUsage(task.id, [{ provider: "codex", model: "old-model", inputTokens: 30, outputTokens: 4 }]);
      expect(store.getTask(task.id)?.usage).toMatchObject([{ inputTokens: 30, outputTokens: 4, totalTokens: 34 }]);
      expect(db!.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(task.id)).toEqual({ revision: 3 });
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
  it("hashes stored coverage in bounded pages with JavaScript Unicode ordering", () => {
    const { task } = fixture();
    const ids = [...Array.from({ length: 1100 }, (_, index) => `request-${String(index).padStart(4, "0")}`), "\uE000", "😀", "é", "é", 'quote"\\newline\n'];
    const expected = createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
    const originalQuery = db!.query.bind(db!);
    let pages = 0;
    const bounded = new Proxy(db!, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (sql.startsWith("SELECT covered_unit_id")) { expect(sql).toContain("LIMIT 512"); pages++; }
        return originalQuery(sql);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const money = unit({ unitId: "unicode-charge", scope: "turn", source: "provider_turn", accuracy: "unknown", costSource: "provider_reported",
      costAmount: 0.25, costCurrency: "USD", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: null, reportedTotalTokens: null, coveredUnitIds: ids, coverageExpectedCount: ids.length, coverageSha256: expected });
    writeUsageSnapshot(bounded, task.id, snapshot([money]));
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(db!.query("SELECT cost_coverage_complete,cost_coverage_sha256 FROM multiremi_usage_units WHERE task_id=? AND unit_id=?").get(task.id, money.unitId)).toEqual({ cost_coverage_complete: 1, cost_coverage_sha256: expected });
    // The upgrade path for earlier coverage rows must obey the same bound.
    db!.run("UPDATE multiremi_usage_cost_coverage SET covered_unit_sort_key=NULL WHERE task_id=?", [task.id]);
    db!.run("UPDATE multiremi_usage_units SET cost_coverage_expected_count=NULL,cost_coverage_sha256=NULL,cost_coverage_received_count=NULL WHERE task_id=?", [task.id]);
    writeUsageSnapshot(bounded, task.id, snapshot([money]));
    expect(db!.query("SELECT cost_coverage_complete,cost_coverage_sha256 FROM multiremi_usage_units WHERE task_id=? AND unit_id=?").get(task.id, money.unitId)).toEqual({ cost_coverage_complete: 1, cost_coverage_sha256: expected });
  });

  it("activates chunked monetary coverage only after its complete committed ID set arrives", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    const ids = ["a", "b", "c"];
    const hash = (set: string[]) => createHash("sha256").update(JSON.stringify([...set].sort())).digest("hex");
    const money = unit({ unitId: "chunked-charge", model: null, modelSource: "unknown", scope: "turn", source: "provider_turn",
      costSource: "provider_reported", costAmount: 0.25, costCurrency: "USD", inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown",
      coverageExpectedCount: ids.length, coverageSha256: hash(ids) });
    store.reportTaskUsageSnapshot(task.id, snapshot(ids.map(unitId => unit({ unitId }))));
    const send = (coveredUnitIds: string[], overrides: Partial<TaskUsageUnit> = {}, revision = 2) => store.reportTaskUsageSnapshot(task.id, snapshot([{ ...money, coveredUnitIds, ...overrides }], { revision }));
    send(["b"]);
    send(["b"]); // Durable replay adds neither links nor charges.
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_usage_cost_coverage WHERE task_id=?").get(task.id)).toEqual({ n: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.complete).toBe(false);
    send(["c"], {}, 1); // Distinct coverage may arrive with an older run frame revision.
    send(["a"]);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ known_cost_by_currency: { USD: 0.25 }, priced_tokens: 36, complete: true });
    expect(db!.query("SELECT cost_coverage_complete FROM multiremi_usage_units WHERE task_id=? AND unit_id=?").get(task.id, money.unitId)).toEqual({ cost_coverage_complete: 1 });
    expect(() => send(["a"], { costAmount: 5 })).toThrow("Conflicting usage unit");
    expect(() => send(["a", "b", "d"], { revision: 2 })).toThrow("Conflicting monetary coverage commitment");
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.known_cost_by_currency).toEqual({ USD: 0.25 });
    const newer = { revision: 2, costAmount: 0.5, coverageExpectedCount: 2, coverageSha256: hash(["a", "b"]) };
    send(["b"], newer, 3);
    send(["a"], {}, 4); // Older unit revision cannot contaminate the new coverage.
    expect(db!.query("SELECT covered_unit_id FROM multiremi_usage_cost_coverage WHERE task_id=? ORDER BY covered_unit_id").all(task.id)).toEqual([{ covered_unit_id: "b" }]);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.complete).toBe(false);
    send(["a"], newer, 3);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ known_cost_by_currency: { USD: 0.50004 }, priced_tokens: 36, complete: true });
    expect(() => validateUsageSnapshot(snapshot([{ ...money, coveredUnitIds: [], coverageSha256: undefined }]))).toThrow("Invalid monetary coverage commitment");
    expect(validateUsageSnapshot(snapshot([{ ...money, coveredUnitIds: [], coverageExpectedCount: 10001 }])).units[0]!.coverageExpectedCount).toBe(10001);
  });

  it("uses a linked request charge instead of adding its configured token price", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    const tokens = unit({ inputTokens: 1_000_000, outputTokens: 0, reportedTotalTokens: 1_000_000 });
    const money = unit({ unitId: "request-charge", model: null, modelSource: "unknown", costSource: "provider_reported", costAmount: 0.25, costCurrency: "USD",
      coveredUnitIds: [tokens.unitId], inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown" });
    // A charge can arrive before its token unit, without falsely claiming completeness.
    store.reportTaskUsageSnapshot(task.id, snapshot([money]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ known_cost_by_currency: {}, complete: false });
    store.reportTaskUsageSnapshot(task.id, snapshot([tokens], { revision: 2 }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 1_000_000,
      known_cost_by_currency: { USD: 0.25 }, priced_tokens: 1_000_000, unpriced_tokens: 0, price_quality: "provider_reported", complete: true });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).by_model).toHaveLength(1);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).by_model[0]).toMatchObject({ model: "opus", known_cost_by_currency: { USD: 0.25 } });
    expect(store.reportTaskUsageSnapshot(task.id, snapshot([money], { revision: 2 }))?.id).toBe(task.id);
    expect(() => store.reportTaskUsageSnapshot(task.id, snapshot([{ ...money, coveredUnitIds: ["different-request"] }], { revision: 3 }))).toThrow("Conflicting usage unit");
    // Explicit zero is also an authoritative reported charge.
    store.reportTaskUsageSnapshot(task.id, snapshot([{ ...money, revision: 2, costAmount: 0 }], { revision: 3 }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.known_cost_by_currency).toEqual({ USD: 0 });
  });

  it("keeps a multi-model turn charge in an unallocated bucket without fabricating per-model zero costs", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    store.setUsagePrice("local", price({ model: "fable" }));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit(), unit({ unitId: "child", model: "fable" }),
      unit({ unitId: "turn-charge", model: null, modelSource: "unknown", scope: "turn", source: "provider_turn", costSource: "provider_reported",
        costAmount: 0.25, costCurrency: "USD", coveredUnitIds: ["request1", "child"], inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown" }),
    ]));
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 24, priced_tokens: 24, known_cost_by_currency: { USD: 0.25 }, complete: true });
    for (const model of ["opus", "fable"]) expect(report.by_model.find(row => row.model === model)).toMatchObject({
      known_cost_by_currency: {}, cost_allocation_complete: false, complete: false, unpriced_tokens: 0,
    });
    expect(report.by_model.find(row => row.model_provenance === "unallocated_cost")).toMatchObject({
      model: null, requested_model: null, actual_total_tokens: 0, known_cost_by_currency: { USD: 0.25 }, cost_allocation_complete: false,
    });
    for (const groups of [report.daily, report.by_agent, report.by_model, report.by_runtime]) {
      expect(groups.reduce((sum, row) => sum + (row.known_cost_by_currency.USD ?? 0), 0)).toBe(0.25);
    }
  });

  it("keeps unlinked or overlapping provider amounts out of known subtotals", () => {
    const { store, task } = fixture();
    store.setUsagePrice("local", price());
    const money = unit({ unitId: "turn-charge", scope: "turn", source: "provider_turn", costSource: "provider_reported", costAmount: 0.25, costCurrency: "USD",
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown" });
    store.reportTaskUsageSnapshot(task.id, snapshot([unit(), money]));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ known_cost_by_currency: { USD: 0.00004 }, complete: false });
    store.reportTaskUsageSnapshot(task.id, snapshot([{ ...money, revision: 2, coveredUnitIds: ["request1"] },
      { ...money, unitId: "second-charge", coveredUnitIds: ["request1"] }], { revision: 2 }));
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ known_cost_by_currency: {}, priced_tokens: 0, unpriced_tokens: 12, complete: false });
    expect(() => validateUsageSnapshot(snapshot([{ ...money, coveredUnitIds: ["request1", "request1"] }]))).toThrow("Invalid monetary coverage");
  });

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
