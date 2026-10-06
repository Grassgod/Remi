import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { assertRequestChargeIdentity, assertUsageIdentityBoundaries } from "./usage-accounting-boundary-cases.js";
import { assertLegacyHistoryBoundary, assertNonconsumingHistoryBoundary, assertRecordedV2RetryChain } from "./usage-legacy-history-boundaries.js";
import { assertRecoveryRevisions, assertRecreatedLegacyReceipt } from "../scripts/usage-reconciliation-revision-cases.js";

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
  it("persists parked revision floors and preserves established owners across PostgreSQL reconnection", () => {
    const jitBefore = db!.query("SHOW jit").get();
    const runtime = store.registerRuntime({ name: "boundary-pg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "boundary-pg", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const tasks = [0, 1].map(index => store.createTask({ agentId: agent.id, prompt: `Boundary ${index}`, workspaceId: "local" }));
    store.claimTask(runtime.id); store.startTask(tasks[0]!.id);
    const connections: PostgresSyncDatabase[] = [];
    try {
      assertUsageIdentityBoundaries(store, db!, tasks[0]!.id, tasks[1]!.id, runtime.id, "postgres-boundaries", () => {
        const isolated = new URL(adminUrl!); isolated.pathname = `/${databaseName}`;
        // A distinct backend connection proves receipts are durable, not cached.
        const reopened = new PostgresSyncDatabase(isolated.toString());
        connections.push(reopened);
        return new MultiremiStore(reopened);
      });
    } finally { for (const connection of connections) connection.close(); }
    expect(db!.query("SHOW jit").get()).toEqual(jitBefore);
  }, 20_000);
  it("protects ordinary v2 consumption from late aggregates and ready-startup rollback on PostgreSQL", () => {
    const agent = store.createAgent({ name: "ordinary pg", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "ordinary native facts", workspaceId: "local" });
    assertLegacyHistoryBoundary(store, db!, task.id, "ordinary-v2-run");
  });
  for (const startupWhileQueued of [false, true]) it(`keeps a real Store v2 retry chain complete on PostgreSQL (startup while queued=${startupWhileQueued})`, async () => {
    await assertRecordedV2RetryChain(store, db!, startupWhileQueued);
  });
  it("rejects overlapping late legacy ingestion and stops source refresh durably on PostgreSQL", () => {
    const agent = store.createAgent({ name: "late old writer pg", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "late legacy boundary", workspaceId: "local" });
    assertLegacyHistoryBoundary(store, db!, task.id);
    for (const kind of ["empty_modern", "empty_history", "context_history"] as const) {
      const other = store.createTask({ agentId: agent.id, prompt: kind, workspaceId: "local" });
      assertNonconsumingHistoryBoundary(store, db!, other.id, kind);
    }
  }, 20_000);
  it("advances stronger historical evidence and recreated legacy receipts on PostgreSQL", async () => {
    const agent = store.createAgent({ name: "revision-pg", provider: "claude", workspaceId: "local" });
    const tasks = [0, 1].map(index => store.createTask({ agentId: agent.id, prompt: `revision ${index}`, workspaceId: "local" }));
    await assertRecoveryRevisions(store, db!, tasks[0]!.id);
    await assertRecreatedLegacyReceipt(store, db!, tasks[1]!.id);
  }, 30_000);
  for (const order of ["money-first", "tokens-first", "identity-later"] as const) it(`rejects contradictory monetary request identity on PostgreSQL with ${order}`, () => {
    const runtime = store.registerRuntime({ name: `charge-pg-${order}`, provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: `charge-pg-${order}`, provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Charge scope", workspaceId: "local" });
    store.claimTask(runtime.id); store.startTask(task.id);
    assertRequestChargeIdentity(store, task.id, runtime.id, `postgres-price-${order}`, order, () => new MultiremiStore(db!));
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
    const report = store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null, tz: "Asia/Shanghai" });
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(report.summary).toMatchObject({ task_count: 1, actual_total_tokens: 2_500_030,
      known_cost_by_currency: { USD: 5 }, unpriced_tokens: 30 });
    expect(report.daily.map(row => [row.date, row.actual_total_tokens])).toEqual([["2026-10-01", 2_500_000], ["2026-10-02", 30]]);
    for (const rows of [report.daily, report.by_agent, report.by_model, report.by_runtime]) {
      expect(rows.reduce((sum, row) => sum + row.actual_total_tokens, 0)).toBe(report.summary.actual_total_tokens);
    }
    expect(Number((db!.query("SELECT count(*) AS count FROM multiremi_usage_units WHERE task_id=?").get(task.id) as { count: string }).count)).toBe(3);
  });

  it("assigns bounded legacy revisions on PostgreSQL at current epoch milliseconds", () => {
    const runtime = store.registerRuntime({ name: "legacy-pg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "legacy-pg", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Legacy revision", workspaceId: "local" });
    store.claimTask(runtime.id); store.startTask(task.id);
    expect(Date.now()).toBeGreaterThan(2_147_483_647);
    for (const inputTokens of [10, 20, 30]) store.reportTaskUsage(task.id, [{ provider: "claude", model: "legacy-model", inputTokens, outputTokens: 2 }]);
    expect(db!.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(task.id)).toEqual({ revision: 3 });
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary).toMatchObject({ actual_total_tokens: 32, task_attributed_tokens: 32, time_provenance: "task_attributed" });
  });

  it("serializes competing native request ownership from two real PostgreSQL processes", async () => {
    const runtime = store.registerRuntime({ name: "ownership-pg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "ownership-pg", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const tasks = [0, 1].map(index => store.createTask({ agentId: agent.id, prompt: `Owner ${index}`, workspaceId: "local" }));
    db!.exec("CREATE TABLE usage_claim_barrier (participant TEXT PRIMARY KEY)");
    const isolated = new URL(adminUrl!); isolated.pathname = `/${databaseName}`;
    const script = `import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
      import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
      const db=new PostgresSyncDatabase(process.env.USAGE_TEST_URL);
      db.run("INSERT INTO usage_claim_barrier(participant) VALUES(?)",[process.env.USAGE_TEST_TASK]);
      let ready=false; for(let i=0;i<500;i++){if(Number(db.query("SELECT COUNT(*) AS n FROM usage_claim_barrier").get().n)===2){ready=true;break;}await Bun.sleep(10);}
      if(!ready)throw Error("Ownership test barrier timed out");
      writeUsageSnapshot(db,process.env.USAGE_TEST_TASK,{version:2,runId:"concurrent",revision:1,complete:true,units:[{
        unitId:"request",revision:1,provider:"claude",model:"concurrent-model",providerSessionId:"concurrent-session",providerRequestId:"concurrent-message",
        connectionId:process.env.USAGE_TEST_ROUTE||null,scope:"request",source:"provider_request",accuracy:"exact",inputTokens:10,outputTokens:2,
        cacheReadTokens:0,cacheWriteTokens:0,actualUnsplitTokens:0,reportedTotalTokens:12,contextTokens:null,contextWindow:null,
        costAmount:null,costCurrency:null,occurredAt:"2026-10-01T00:00:00Z"}]});db.close();`;
    const children = tasks.map((task, index) => Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, USAGE_TEST_URL: isolated.toString(), USAGE_TEST_TASK: task.id, USAGE_TEST_ROUTE: index ? "confirmed-route" : "" }, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async child => ({ exit: await child.exited, error: await new Response(child.stderr).text() })));
    for (const result of results) expect(result).toEqual({ exit: 0, error: "" });
    expect(Number((db!.query("SELECT SUM(input_tokens+output_tokens) AS n FROM multiremi_usage_units WHERE provider_request_id='concurrent-message'").get() as { n: string }).n)).toBe(12);
    expect(Number((db!.query("SELECT COUNT(*) AS n FROM multiremi_usage_request_owners WHERE provider_request_id='concurrent-message'").get() as { n: string }).n)).toBe(1);
    expect(Number((db!.query("SELECT COUNT(*) AS n FROM multiremi_usage_identity_conflicts WHERE run_id='concurrent'").get() as { n: string }).n)).toBe(1);
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary).toMatchObject({ actual_total_tokens: 12, identity_conflict_task_count: 2, complete: false });
  });

  it("keeps cumulative-meter overlap auditable on PostgreSQL without counting it twice", () => {
    const runtime = store.registerRuntime({ name: "meter-pg", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "meter-pg", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Meter interval", workspaceId: "local" });
    const vector = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: n });
    const meter = (id: string, before: number, after: number, epochId = "initial"): TaskUsageUnit => ({ unitId: id, revision: 1, provider: "codex", model: null,
      providerSessionId: "pg-meter-session", providerObservationId: id, identityKind: "cumulative_meter", meterEvidence: { epochId, before: vector(before), after: vector(after) },
      source: "provider_turn", scope: "turn", accuracy: "exact", inputTokens: after - before, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: after - before, contextTokens: null, contextWindow: null,
      costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00Z" });
    const write = (runId: string, units: TaskUsageUnit[]) => store.reportTaskUsageSnapshot(task.id, { version: 2, runId, revision: 1, complete: true, units });
    write("original", [meter("first", 0, 100), meter("second", 100, 200)]);
    write("duplicate-resume", [meter("overlap", 0, 300)]);
    write("verified-continuation", [meter("next", 200, 300)]);
    write("live-reset", [meter("reset", 0, 50, "compaction-item:explicit-id")]);
    write("native-same-reset", [meter("native-reset", 0, 50, "compaction-timestamp:2026-10-01T00:00:00Z")]);
    expect(store.getUsageReport({ workspaceId: "local", runtimeId: runtime.id, days: null }).summary).toMatchObject({ actual_total_tokens: 350, identity_conflict_task_count: 1, complete: false });
    const stored = db!.query("SELECT meter_evidence,identity_kind FROM multiremi_usage_units WHERE task_id=? AND unit_id='first'").get(task.id) as { meter_evidence: string; identity_kind: string };
    expect(JSON.parse(stored.meter_evidence)).toEqual({ epochId: "initial", before: [0, 0, 0, 0, 0], after: [100, 0, 0, 0, 100], last: null });
    expect(stored.identity_kind).toBe("cumulative_meter");
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
