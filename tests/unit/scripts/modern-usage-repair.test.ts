import { afterEach, describe, expect, it } from "bun:test";
import { actualUnit, requestUnitId, unitActualTotal } from "../../../packages/acp/src/usage-collector.js";
import { writeUsageSnapshot } from "../../../packages/server/src/store/usage-accounting.js";
import { applyModernUsageRepairs, buildModernUsageRepairs, readModernRepairState, storedUsageUnit, verifyModernUsageRepairs } from "../../../scripts/modern-usage-repair.js";
import { parseNativeUsageEvidence } from "../../../scripts/usage-evidence.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";
afterEach(resetMultiremiTestEnv);
const at = "2026-10-01T01:00:00.000Z";
function fixture(provider = "claude") {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "repair", provider });
  const task = store.createTask({ agentId: agent.id, prompt: "synthetic historical repair" });
  db!.run("UPDATE multiremi_tasks SET status='completed',provider=?,session_id='native-session',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [provider, task.id]);
  return { store, task };
}
const request = (output: number) => ({ ...actualUnit({ unitId: requestUnitId("response", "native-session"), provider: "claude", providerSessionId: "native-session", providerRequestId: "response", model: "real-model", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: output, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 30 + output }), occurredAt: at });
describe("reviewed terminal modern usage repairs", () => {
  it("retains unknown consumption coverage in the report when an old unscoped meter overlaps exact requests", () => {
    const { task, store } = fixture("codex");
    const counts = { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 };
    const body = [
      { type: "session_meta", payload: { id: "native-session" } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: counts, last_token_usage: counts } } },
      { type: "token_usage_record", timestamp: at, payload: { thread_id: "native-session", turn_id: "native-turn", response_id: "native-response", usage: counts } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    const parsed = parseNativeUsageEvidence("codex", body, "archive:synthetic");
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: parsed.units }, { historical: true });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 41, unknown_task_count: 1 });
  });
  it("corrects final request counters and retires only the matching settlement gap without changing summary, costs or context", () => {
    const { task } = fixture();
    const early = request(1), final = { ...request(11), evidenceRef: "archive:synthetic#line=2" };
    const remainder = { ...actualUnit({ unitId: "settle:prompt", provider: "claude", scope: "turn", source: "provider_turn", evidenceRef: "acp_prompt_unattributed_remainder" }), actualUnsplitTokens: 10, accuracy: "unknown" as const, occurredAt: at };
    const summary = { ...request(2), unitId: "summary:request", purpose: "progress_summary", providerRequestId: "summary-response" };
    const context = { ...actualUnit({ unitId: "context:prompt", provider: "claude", scope: "turn", source: "context_snapshot", accuracy: "unknown" }), contextTokens: 100, contextWindow: 1000, occurredAt: at };
    const money = { ...actualUnit({ unitId: "cost:prompt", provider: "claude", scope: "turn", source: "provider_turn" }), costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported" as const, coveredUnitIds: [early.unitId, remainder.unitId], occurredAt: at };
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 2, complete: true, units: [early, remainder, summary, context, money] }, { historical: true });
    const state = readModernRepairState(db!, task.id);
    const repairs = buildModernUsageRepairs(state, [final], []);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.beforeActualTokens).toBe(repairs[0]!.afterActualTokens);
    expect(repairs[0]!.retiredRemainderIds).toEqual([remainder.unitId]);
    expect(repairs[0]!.snapshot.units.find(unit => unit.unitId === summary.unitId)).toEqual(storedUsageUnit(state.units.find(row => row.unit_id === summary.unitId)!, state.coverage));
    expect(applyModernUsageRepairs(db!, repairs, "synthetic-plan")).toEqual({ applied: 1, resumed: 0 });
    expect(verifyModernUsageRepairs(db!, repairs, "synthetic-plan")).toBe(1);
    expect(applyModernUsageRepairs(db!, repairs, "synthetic-plan")).toEqual({ applied: 0, resumed: 1 });
    expect(db!.query("SELECT actual_unsplit_tokens FROM multiremi_usage_units WHERE task_id=? AND unit_id=?").get(task.id, remainder.unitId)).toBeNull();
    expect(db!.query("SELECT disposition FROM multiremi_usage_unit_receipts WHERE task_id=? AND unit_id=?").get(task.id, remainder.unitId)).toEqual({ disposition: "superseded" });
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 999, complete: true, units: [{ ...remainder, revision: 999 }] }, { historical: true });
    expect(db!.query("SELECT unit_id FROM multiremi_usage_units WHERE task_id=? AND unit_id=?").get(task.id, remainder.unitId)).toBeNull();
    expect(verifyModernUsageRepairs(db!, repairs, "synthetic-plan")).toBe(1);
    const current = readModernRepairState(db!, task.id);
    expect(current.units.find(row => row.unit_id === summary.unitId)?.output_tokens).toBe(2);
    expect(current.units.find(row => row.unit_id === context.unitId)?.context_tokens).toBe(100);
    expect(current.units.find(row => row.unit_id === money.unitId)?.cost_amount).toBe(0.25);
    expect(current.coverage.filter(row => row.monetary_unit_id === money.unitId).map(row => row.covered_unit_id)).toEqual([early.unitId]);
  });
  it("rejects stale receipts and skips non-final or competing runs and unexplained remainder", () => {
    const { task } = fixture();
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: [request(1)] }, { historical: true });
    const state = readModernRepairState(db!, task.id);
    const repairs = buildModernUsageRepairs(state, [request(11)], []);
    expect(repairs).toHaveLength(1);
    db!.run("UPDATE multiremi_usage_unit_receipts SET revision=20 WHERE task_id=?", [task.id]);
    expect(() => applyModernUsageRepairs(db!, repairs, "stale")).toThrow("changed after plan");
    expect(buildModernUsageRepairs({ ...state, runs: state.runs.map(run => ({ ...run, complete: 0 })) }, [request(11)], [])).toEqual([]);
    expect(buildModernUsageRepairs({ ...state, runs: [...state.runs, { run_id: "another-run", revision: 1, complete: 1 }] }, [request(11)], [])).toEqual([]);
    expect(buildModernUsageRepairs({ ...state, task: { ...state.task, session_id: "other-session" } }, [request(11)], [])).toEqual([]);
    for (const invalid of [{ ...request(11), outputTokens: null }, { ...request(11), inputTokens: -1 }, { ...request(11), reportedTotalTokens: 99 }]) {
      expect(buildModernUsageRepairs(state, [invalid], [])).toEqual([]);
    }
  });
  it("recovers native Codex response records including compaction only with the preserved exact session prefix", () => {
    const { task } = fixture("codex");
    const unknown = { ...actualUnit({ unitId: 'request:native-session:epoch:0:{"inputTokens":10,"cachedInputTokens":20,"outputTokens":1,"totalTokens":31}', provider: "codex", scope: "request", source: "provider_request", accuracy: "unknown", evidenceRef: "codex_meter_epoch_unresolved" }), occurredAt: at };
    const native = [1, 2].map(index => ({ ...actualUnit({ unitId: requestUnitId(`response-${index}`, "native-session"), provider: "codex", providerSessionId: "native-session", providerRequestId: `response-${index}`, scope: "request", source: "provider_request", inputTokens: 10 * index, outputTokens: index, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 11 * index + 20 }), occurredAt: at, evidenceRef: `archive:synthetic#line=${index}` }));
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: [unknown] }, { historical: true });
    const state = readModernRepairState(db!, task.id);
    const repairs = buildModernUsageRepairs(state, native, []);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.afterActualTokens).toBe(73);
    expect(repairs[0]!.supersededUnitIds).toEqual([]);
    expect(repairs[0]!.snapshot.units.some(unit => unit.unitId === unknown.unitId && unit.accuracy === "unknown")).toBe(true);
    expect(applyModernUsageRepairs(db!, repairs, "codex-plan").applied).toBe(1);
    expect(verifyModernUsageRepairs(db!, repairs, "codex-plan")).toBe(1);
    const proof = { providerSessionId: "native-session", turnId: "native-turn", responseIds: ["response-1", "response-2"], startedAt: "2026-10-01T00:30:00Z", startEvidenceRef: "archive:synthetic#line=1", completedAt: "2026-10-01T01:30:00Z", completionEvidenceRef: "archive:synthetic#line=4", totalsEvidenceRef: "archive:synthetic#line=3", inputTokens: 30, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 73 };
    const complete = buildModernUsageRepairs(readModernRepairState(db!, task.id), native, [], [proof]);
    expect(complete[0]!.correctedRequestIds).toEqual([]);
    expect(complete[0]!.supersededUnitIds).toEqual([unknown.unitId]);
    expect(applyModernUsageRepairs(db!, complete, "codex-completed-plan").applied).toBe(1);
    const wrong = { ...state, units: state.units.map(row => ({ ...row, unit_id: "request:other-session:epoch:0:synthetic" })) };
    expect(buildModernUsageRepairs(wrong, native, [])).toEqual([]);
    expect(native.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(73);
  });
  it("retires old unknown observations only after the complete native turn reconciles, and fails closed without the original receipt", () => {
    const { task } = fixture("codex");
    const unknown = { ...actualUnit({ unitId: 'request:native-session:epoch:0:{"inputTokens":10,"cachedInputTokens":20,"outputTokens":1,"totalTokens":31}', provider: "codex", scope: "request", source: "provider_request", accuracy: "unknown", evidenceRef: "codex_meter_epoch_unresolved" }), occurredAt: at };
    const native = { ...actualUnit({ unitId: requestUnitId("native-response", "native-session"), provider: "codex", providerSessionId: "native-session", providerRequestId: "native-response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 11, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 41 }), occurredAt: at };
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: [unknown] }, { historical: true });
    const proof = { providerSessionId: "native-session", turnId: "native-turn", responseIds: ["native-response"], startedAt: "2026-10-01T00:30:00Z", startEvidenceRef: "archive:synthetic#line=1", completedAt: "2026-10-01T01:30:00Z", completionEvidenceRef: "archive:synthetic#line=3", totalsEvidenceRef: "archive:synthetic#line=2", inputTokens: 10, outputTokens: 11, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 41 };
    const state = readModernRepairState(db!, task.id);
    const full = buildModernUsageRepairs(state, [native], [], [proof]);
    expect(full[0]!.coverage).toBe("complete_native_turn");
    expect(full[0]!.supersededUnitIds).toEqual([unknown.unitId]);
    const otherTurnRow = { ...state.units[0]!, unit_id: state.units[0]!.unit_id.replace(":epoch:0:", ":epoch:1:"), occurred_at: "2026-10-01T00:15:00Z" };
    const multipleTurns = buildModernUsageRepairs({ ...state, units: [...state.units, otherTurnRow] }, [native], [], [proof]);
    expect(multipleTurns[0]!.supersededUnitIds).toEqual([unknown.unitId]);
    expect(multipleTurns[0]!.snapshot.units.find(unit => unit.unitId === otherTurnRow.unit_id)).toMatchObject({ accuracy: "unknown", inputTokens: null });
    expect(buildModernUsageRepairs(state, [native], [], [{ ...proof, totalTokens: 99 }])[0]!.supersededUnitIds).toEqual([]);
    expect(buildModernUsageRepairs({ ...state, units: state.units.map(row => ({ ...row, occurred_at: "2026-10-01T00:15:00Z" })) }, [native], [], [proof])[0]!.supersededUnitIds).toEqual([]);
    db!.run("DELETE FROM multiremi_usage_unit_receipts WHERE task_id=?", [task.id]);
    const missing = buildModernUsageRepairs(readModernRepairState(db!, task.id), [native], [], [proof]);
    expect(() => applyModernUsageRepairs(db!, missing, "missing-receipt")).toThrow("requires a persisted receipt");
    expect(readModernRepairState(db!, task.id).units).toHaveLength(1);
    for (const receipt of state.receipts) db!.run("INSERT INTO multiremi_usage_unit_receipts(task_id,run_id,unit_id,revision,disposition,normalized_json) VALUES(?,?,?,?,?,?)", [task.id, receipt.run_id, receipt.unit_id, receipt.revision, receipt.disposition, receipt.normalized_json]);
    expect(applyModernUsageRepairs(db!, full, "complete-turn").applied).toBe(1);
    expect(verifyModernUsageRepairs(db!, full, "complete-turn")).toBe(1);
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 999, complete: true, units: [{ ...unknown, revision: 999 }] }, { historical: true });
    expect(readModernRepairState(db!, task.id).units.some(row => row.unit_id === unknown.unitId)).toBe(false);
    expect(verifyModernUsageRepairs(db!, full, "complete-turn")).toBe(1);
  });
});
