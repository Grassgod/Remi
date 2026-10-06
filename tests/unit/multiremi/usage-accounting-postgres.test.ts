import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

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
});
