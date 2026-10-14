import { afterEach, describe, expect, it } from "bun:test";
import { actualUnit, requestUnitId } from "@acp/usage-collector.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { buildReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";
import { buildModernUsageRepairs, readModernRepairState } from "../../../scripts/modern-usage-repair.js";
import { parseNativeUsageEvidence, reconcileNativeSourceEvidence } from "../../../scripts/usage-evidence.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";

const at = "2026-10-01T01:00:00.000Z";
afterEach(() => resetMultiremiTestEnv());

function fixture(provider: "claude" | "codex" = "claude") {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Unified usage evidence", provider });
  const task = store.createTask({ agentId: agent.id, prompt: "attempt evidence" });
  runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',provider=?,session_id='native-session',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [provider, task.id]);
  return { store, agent, task };
}

const sqlOverTestDb = () => ({ unsafe: async (statement: string, params: any[] = []) => db!.query(statement.replace(/\$\d+/g, "?")).all(...params) }) as unknown as Bun.SQL;

/** Native provider evidence as the repair planner receives it: parsed, then reconciled against its completed turns. */
function nativeEvidence(provider: "claude" | "codex", rows: unknown[]) {
  const evidence = parseNativeUsageEvidence(provider, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "native:synthetic");
  const completedTurns = evidence.completedTurns ?? [];
  return { units: reconcileNativeSourceEvidence(evidence.sourceUnits ?? evidence.units, evidence.sourceScopes ?? [], completedTurns), completedTurns };
}

describe("usage evidence on unified attempts", () => {
  it("rejects a nonempty plan on an unsupported schema before any reconciliation DDL", async () => {
    const { task } = fixture();
    const early = { ...actualUnit({ unitId: requestUnitId("response", "native-session"), provider: "claude", providerSessionId: "native-session", providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 }), occurredAt: at };
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: [early] }, { historical: true });
    const plan = await buildReconcileUsagePlan(sqlOverTestDb(), { taskId: task.id });
    plan.modernRepairs = buildModernUsageRepairs(readModernRepairState(db!, task.id), [{ ...early, outputTokens: 11, reportedTotalTokens: 41, accuracy: "exact", actualUnsplitTokens: 0 }], []);
    expect(plan.modernRepairs).toHaveLength(1);
    const tables = db!.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const units = db!.query("SELECT * FROM multiremi_usage_units").all();
    db!.exec("DROP VIEW multiremi_turn_execution_records");
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("Unsupported usage reconciliation schema");
    expect(db!.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tables);
    expect(db!.query("SELECT * FROM multiremi_usage_units").all()).toEqual(units);
  });
  for (const provider of ["claude", "codex"] as const) it(`plans, applies and resumes final ${provider} request repair from native evidence`, async () => {
    const { store, task } = fixture(provider);
    const early = provider === "claude"
      ? actualUnit({ unitId: requestUnitId("response", "native-session"), provider, providerSessionId: "native-session", providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 })
      : actualUnit({ unitId: 'request:native-session:epoch:0:{"inputTokens":10,"cachedInputTokens":20,"outputTokens":1,"totalTokens":31}', provider, scope: "request", source: "provider_request", accuracy: "unknown", evidenceRef: "codex_meter_epoch_unresolved" });
    early.occurredAt = at;
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "original-run", revision: 1, complete: true, units: [early] }, { historical: true });
    const rows = provider === "claude"
      ? [{ type: "assistant", timestamp: at, sessionId: "native-session", message: { id: "response", stop_reason: "end_turn", model: "actual-model", usage: { input_tokens: 10, output_tokens: 11, cache_read_input_tokens: 20 } } }]
      : [{ type: "session_meta", payload: { id: "native-session" } },
        { type: "event_msg", timestamp: "2026-10-01T00:30:00Z", payload: { type: "task_started", turn_id: "native-turn" } },
        { type: "token_usage_record", timestamp: at, payload: { thread_id: "native-session", turn_id: "native-turn", response_id: "response", usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 }, turn_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 } } },
        { type: "event_msg", timestamp: "2026-10-01T01:30:00Z", payload: { type: "task_complete", turn_id: "native-turn" } }];
    const plan = await buildReconcileUsagePlan(sqlOverTestDb(), { taskId: task.id });
    expect(plan.tasks).toHaveLength(0);
    const native = nativeEvidence(provider, rows);
    plan.modernRepairs = buildModernUsageRepairs(readModernRepairState(db!, task.id), native.units, [], native.completedTurns);
    expect(plan.modernRepairs).toHaveLength(1);
    expect(plan.modernRepairs![0]).toMatchObject({ taskId: task.id, afterActualTokens: 41, snapshot: { runId: "original-run" } });
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 1, resumed: 0 });
    expect(verifyUsageReconciliation(db!, plan).tasks).toBe(1);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(41);
    expect(buildModernUsageRepairs(readModernRepairState(db!, task.id), native.units, [], native.completedTurns)).toHaveLength(0);
  });

  it("plans, applies and reports raw usage retained in task messages by exact attempt identity", async () => {
    const { store, task } = fixture();
    const meta = { _meta: { remiTokenUsage: { id: "response", providerSessionId: "native-session", providerRequestId: "response", inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } };
    store.appendTaskMessages(task.id, [{ seq: 1, type: "usage", meta }]);
    const plan = await buildReconcileUsagePlan(sqlOverTestDb(), { taskId: task.id });
    expect(plan.counts).toMatchObject({ rawEvents: 1, replayed: 0, rejected: 0 });
    expect(plan.tasks[0]).toMatchObject({ taskId: task.id, source: "raw", actualTokens: 12, countedActualTokens: 12 });
    expect(applyUsageReconciliation(db!, plan).applied).toBe(1);
    expect(verifyUsageReconciliation(db!, plan).actualTokens).toBe(12);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(12);
  });
});
