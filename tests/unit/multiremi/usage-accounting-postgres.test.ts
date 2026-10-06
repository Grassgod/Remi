import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `multiremi_usage_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let admin: Bun.SQL | undefined;
let db: PostgresSyncDatabase | undefined;
let store: MultiremiStore;

describe.skipIf(!adminUrl)("normalized usage on PostgreSQL", () => {
  beforeAll(async () => {
    if (!adminUrl || !/^multiremi_usage_pg_\d+_\d+$/.test(databaseName)) throw new Error("Invalid isolated database target");
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    db = new PostgresSyncDatabase(url.toString());
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    db?.close();
    if (admin && /^multiremi_usage_pg_\d+_\d+$/.test(databaseName)) {
      await admin.unsafe(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  });

  it("migrates, merges out-of-order retries after cancellation and reconciles timestamped prices in SQL", () => {
    const runtime = store.registerRuntime({ name: "usage-pg", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "usage-pg", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Account for real events", workspaceId: "local" });
    store.claimTask(runtime.id);
    store.startTask(task.id);
    store.cancelTask(task.id);
    const unit: TaskUsageUnit = { unitId: "request-one", revision: 1, provider: "codex", model: null,
      requestedModel: "gateway-model", modelSource: "session_acknowledged", connectionId: "workspace:local:relay:codex",
      scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 1_000_000,
      contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T15:59:00.000Z" };
    store.setUsagePrice("local", { provider: "codex", model: "gateway-model", connection_id: unit.connectionId!,
      requested_model_alias: true, currency: "USD", input_per_million: 2, output_per_million: 0,
      cache_read_per_million: 0, cache_write_per_million: 0, unsplit_per_million: null,
      source: "configured", source_url: null, effective_from: "2026-10-01T00:00:00.000Z", effective_to: null });
    const snapshot = (units: TaskUsageUnit[], revision = 1, runId = "run-one") => ({ version: 2 as const, runId, revision, complete: true, units });
    store.reportTaskUsageSnapshot(task.id, snapshot([unit], 10));
    store.reportTaskUsageSnapshot(task.id, snapshot([unit], 1));
    store.reportTaskUsageSnapshot(task.id, snapshot([{ ...unit, revision: 2, inputTokens: 2_000_000, reportedTotalTokens: 2_000_000 }], 11));
    store.reportTaskUsageSnapshot(task.id, snapshot([{ ...unit, unitId: "child", model: "actual-child", modelSource: "provider_reported",
      inputTokens: 30, reportedTotalTokens: 30, occurredAt: "2026-10-01T16:01:00.000Z", connectionId: null }], 2));
    store.reportTaskUsageSnapshot(task.id, snapshot([{ ...unit, inputTokens: 500_000, reportedTotalTokens: 500_000 }], 1, "retry"));
    const report = store.getUsageReport({ workspaceId: "local", days: null, tz: "Asia/Shanghai" });
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(report.summary).toMatchObject({ task_count: 1, actual_total_tokens: 2_500_030,
      known_cost_by_currency: { USD: 5 }, unpriced_tokens: 30 });
    expect(report.daily.map(row => [row.date, row.actual_total_tokens])).toEqual([["2026-10-01", 2_500_000], ["2026-10-02", 30]]);
    for (const rows of [report.daily, report.by_agent, report.by_model, report.by_runtime]) {
      expect(rows.reduce((sum, row) => sum + row.actual_total_tokens, 0)).toBe(report.summary.actual_total_tokens);
    }
    expect(Number((db!.query("SELECT count(*) AS count FROM multiremi_usage_units").get() as { count: string }).count)).toBe(3);
  });

  it("persists charge coverage and never adds reported charges to covered configured estimates", () => {
    const runtime = store.registerRuntime({ name: "charge-pg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "charge-pg", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Covered charge", workspaceId: "local" });
    const tokens: TaskUsageUnit = { unitId: "request", revision: 1, provider: "claude", model: "pg-charge-model", modelSource: "provider_reported",
      scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 1_000_000, contextTokens: null, contextWindow: null,
      costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00.000Z" };
    const money: TaskUsageUnit = { ...tokens, unitId: "charge", model: null, modelSource: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown", costAmount: 0.25,
      costCurrency: "USD", costSource: "provider_reported", coveredUnitIds: [tokens.unitId] };
    store.setUsagePrice("local", { provider: "claude", model: tokens.model!, connection_id: null, requested_model_alias: false,
      currency: "USD", input_per_million: 2, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0,
      unsplit_per_million: null, source: "configured", source_url: null, effective_from: "2026-09-01T00:00:00.000Z", effective_to: null });
    store.claimTask(runtime.id);
    store.startTask(task.id);
    store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "charge-run", revision: 1, complete: true, units: [money] });
    store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "charge-run", revision: 2, complete: true, units: [tokens] });
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary).toMatchObject({
      actual_total_tokens: 1_000_000, priced_tokens: 1_000_000, known_cost_by_currency: { USD: 0.25 }, complete: true,
    });
    expect(db!.query("SELECT covered_unit_id FROM multiremi_usage_cost_coverage WHERE task_id=?").all(task.id)).toEqual([{ covered_unit_id: "request" }]);
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).by_model).toEqual([
      expect.objectContaining({ model: tokens.model, known_cost_by_currency: { USD: 0.25 } }),
    ]);
    expect(() => store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "charge-run", revision: 3, complete: true,
      units: [{ ...money, coveredUnitIds: ["unproven-target"] }] })).toThrow("Conflicting usage unit");
    const nextCharge: TaskUsageUnit = { ...money, revision: 2, costAmount: 0.5, coveredUnitIds: ["request"], coverageExpectedCount: 2,
      coverageSha256: createHash("sha256").update(JSON.stringify(["request", "second-request"])).digest("hex") };
    store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "charge-run", revision: 3, complete: true, units: [nextCharge, { ...tokens, unitId: "second-request" }] });
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary.complete).toBe(false);
    expect(db!.query("SELECT cost_coverage_received_count,cost_coverage_complete FROM multiremi_usage_units WHERE task_id=? AND unit_id='charge'").get(task.id)).toEqual({ cost_coverage_received_count: 1, cost_coverage_complete: 0 });
    store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "charge-run", revision: 2, complete: true, units: [{ ...nextCharge, coveredUnitIds: ["second-request"] }] });
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary).toMatchObject({ actual_total_tokens: 2_000_000,
      priced_tokens: 2_000_000, known_cost_by_currency: { USD: 0.5 }, complete: true });
    const longIds = [...Array.from({ length: 5000 }, (_, index) => `${String(index).padStart(6, "0")}:${"x".repeat(240)}`), "\uE000", "😀", "é", "é", 'quote"\\newline\n'];
    const sha256 = createHash("sha256").update(JSON.stringify([...longIds].sort())).digest("hex");
    const isolated = new URL(adminUrl!); isolated.pathname = `/${databaseName}`;
    const smallBridge = new PostgresSyncDatabase(isolated.toString(), 1024 * 1024);
    try {
      writeUsageSnapshot(smallBridge, task.id, { version: 2, runId: "charge-run", revision: 4, complete: true,
        units: [{ ...money, scope: "turn", revision: 3, coveredUnitIds: longIds, coverageExpectedCount: longIds.length, coverageSha256: sha256 }] });
      expect(smallBridge.query("SELECT cost_coverage_complete,cost_coverage_sha256 FROM multiremi_usage_units WHERE task_id=? AND unit_id='charge'").get(task.id)).toEqual({ cost_coverage_complete: 1, cost_coverage_sha256: sha256 });
      // An unbounded read of these exact rows exceeds the deliberately small
      // bridge, proving the successful hash verification used bounded pages.
      expect(() => smallBridge.query("SELECT covered_unit_id FROM multiremi_usage_cost_coverage WHERE task_id=?").all(task.id)).toThrow(/bridge result too large.*1048576 bytes/);
    } finally { smallBridge.close(); }
  });
});
