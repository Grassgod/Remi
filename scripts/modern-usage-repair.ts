/** Reviewed corrections to existing terminal execution runs, never a new ledger. */
import { createHash } from "node:crypto";
import type { TaskUsageSnapshot, TaskUsageUnit } from "../packages/contracts/src/usage-accounting.js";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { lockUsageIdentities, writeUsageSnapshot } from "../packages/server/src/store/usage-accounting.js";
import { unitActualTotal } from "../packages/acp/src/usage-collector.js";
import { markRequestReadCacheLockTaken } from "../packages/server/src/store/request-read-cache.js";
import type { CompletedNativeTurn } from "./usage-evidence.js";

type Row = Record<string, any>;
export interface NativeRunScope {
  taskId: string; runId: string; providerSessionId: string;
  /** A reviewed run/session binding from immutable execution/archive evidence. */
  evidenceRef: string;
}
export interface ModernUsageRepair {
  taskId: string; expectedStateSha256: string; scope: NativeRunScope;
  snapshot: TaskUsageSnapshot; beforeActualTokens: number; afterActualTokens: number;
  correctedRequestIds: string[]; retiredRemainderIds: string[];
  nativeEvidence: TaskUsageUnit[]; supersededUnitIds: string[];
  coverage: "partial" | "complete_native_turn"; completedTurns: CompletedNativeTurn[];
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (value: string) => ["completed", "failed", "cancelled"].includes(value);
function unresolvedCodexSession(unit: TaskUsageUnit, sessionId: string): boolean {
  if (unit.provider !== "codex" || unit.evidenceRef !== "codex_meter_epoch_unresolved" || unitActualTotal(unit) !== 0) return false;
  const prefix = `request:${sessionId}:epoch:`;
  if (!unit.unitId.startsWith(prefix)) return false;
  const suffix = unit.unitId.slice(prefix.length), separator = suffix.indexOf(":");
  if (separator < 1 || !/^\d+$/.test(suffix.slice(0, separator))) return false;
  try {
    const counts = JSON.parse(suffix.slice(separator + 1));
    return ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      && counts.inputTokens + counts.cachedInputTokens + counts.outputTokens === counts.totalTokens;
  } catch { return false; }
}
function validNativeRequest(unit: TaskUsageUnit): boolean {
  const values = [unit.inputTokens, unit.outputTokens, unit.cacheReadTokens, unit.cacheWriteTokens];
  return unit.source === "provider_request" && unit.scope === "request" && unit.accuracy === "exact" && values.every(value => Number.isSafeInteger(value) && value! >= 0)
    && Number.isSafeInteger(unit.reportedTotalTokens) && unit.reportedTotalTokens! >= 0
    && values.reduce<number>((sum, value) => sum + value!, 0) === unit.reportedTotalTokens
    && unit.actualUnsplitTokens === 0;
}
const fieldNames = {
  unit_id: "unitId", model_source: "modelSource", requested_model: "requestedModel", connection_id: "connectionId",
  provider_session_id: "providerSessionId", provider_request_id: "providerRequestId", provider_observation_id: "providerObservationId",
  identity_kind: "identityKind", time_provenance: "timeProvenance", input_tokens: "inputTokens", output_tokens: "outputTokens",
  cache_read_tokens: "cacheReadTokens", cache_write_tokens: "cacheWriteTokens", actual_unsplit_tokens: "actualUnsplitTokens",
  reported_total_tokens: "reportedTotalTokens", context_tokens: "contextTokens", context_window: "contextWindow",
  cost_amount: "costAmount", cost_currency: "costCurrency", cost_source: "costSource", occurred_at: "occurredAt",
  evidence_ref: "evidenceRef", cost_coverage_expected_count: "coverageExpectedCount", cost_coverage_sha256: "coverageSha256",
} as const;
const numeric = new Set(["revision", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "actualUnsplitTokens", "reportedTotalTokens", "contextTokens", "contextWindow", "costAmount", "coverageExpectedCount"]);
export function storedUsageUnit(row: Row, coverage: Row[]): TaskUsageUnit {
  const result: Row = {};
  for (const key of ["revision", "provider", "model", "purpose", "scope", "source", "accuracy"]) result[key] = row[key];
  for (const [column, key] of Object.entries(fieldNames)) {
    if (["coverageExpectedCount", "coverageSha256", "identityKind", "providerObservationId"].includes(key) && row[column] == null) continue;
    result[key] = row[column];
  }
  for (const key of numeric) if (result[key] != null) result[key] = Number(result[key]);
  if (row.meter_evidence) {
    const meter = JSON.parse(row.meter_evidence);
    const vector = (values: number[]) => Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"].map((key, index) => [key, values[index]]));
    result.meterEvidence = { epochId: meter.epochId, before: vector(meter.before), after: vector(meter.after), ...(meter.last ? { last: vector(meter.last) } : {}) };
  }
  const links = coverage.filter(link => link.run_id === row.run_id && link.monetary_unit_id === row.unit_id).map(link => link.covered_unit_id).sort();
  if (links.length || row.cost_coverage_expected_count != null) result.coveredUnitIds = links;
  return result as TaskUsageUnit;
}
export function modernRepairState(task: Row, units: Row[], runs: Row[], receipts: Row[], coverage: Row[], scopes: Row[]): string {
  return sha({ task, units, runs, receipts, coverage, scopes });
}
export function readModernRepairState(db: SqlDatabase, taskId: string) {
  return {
    task: db.query("SELECT id,workspace_id,provider,status,session_id,usage,started_at,completed_at,failed_at,cancelled_at FROM multiremi_turn_execution_records WHERE id=?").get(taskId) as Row,
    units: db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(taskId) as Row[],
    runs: db.query("SELECT * FROM multiremi_usage_runs WHERE task_id=? ORDER BY run_id").all(taskId) as Row[],
    receipts: db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(taskId) as Row[],
    coverage: db.query("SELECT * FROM multiremi_usage_cost_coverage WHERE task_id=? ORDER BY run_id,monetary_unit_id,covered_unit_id").all(taskId) as Row[],
    scopes: db.query("SELECT * FROM multiremi_usage_run_scopes WHERE task_id=? ORDER BY run_id").all(taskId) as Row[],
  };
}
export const modernStateHash = (state: ReturnType<typeof readModernRepairState>) => modernRepairState(state.task, state.units, state.runs, state.receipts, state.coverage, state.scopes);

/** Only exact same-session requests may revise known rows. Missing requests need an explicit reviewed run binding. */
export function buildModernUsageRepairs(state: ReturnType<typeof readModernRepairState>, native: TaskUsageUnit[], scopes: NativeRunScope[], completedTurns: CompletedNativeTurn[] = []): ModernUsageRepair[] {
  if (!state.task || !terminal(state.task.status)) return [];
  const liveRuns = state.runs.filter(row => !["legacy", "historical-evidence-v2"].includes(row.run_id));
  if (liveRuns.length !== 1 || Number(liveRuns[0]!.complete) !== 1) return [];
  const repairs: ModernUsageRepair[] = [];
  for (const run of state.runs.filter(row => !["legacy", "historical-evidence-v2"].includes(row.run_id))) {
    const rows = state.units.filter(row => row.run_id === run.run_id);
    const units = rows.map(row => storedUsageUnit(row, state.coverage));
    const main = units.filter(unit => (unit.purpose ?? "agent") === "agent" && unit.source === "provider_request"
      && !(unit.costAmount != null && unitActualTotal(unit) === 0 && unit.reportedTotalTokens == null));
    const sessions = [...new Set(main.map(unit => unit.providerSessionId).filter(Boolean))];
    const explicit = scopes.find(scope => scope.taskId === state.task.id && scope.runId === run.run_id);
    const nativeSessions = [...new Set(native.map(unit => unit.providerSessionId).filter(Boolean))];
    const legacyCodexSession = nativeSessions.length === 1 && main.some(unit => unresolvedCodexSession(unit, nativeSessions[0]!))
      && main.every(unit => unresolvedCodexSession(unit, nativeSessions[0]!) || (unit.provider === "codex" && unit.providerSessionId === nativeSessions[0] && unit.providerRequestId)) ? nativeSessions[0] : null;
    const sessionId = explicit?.providerSessionId ?? (sessions.length === 1 ? sessions[0] : legacyCodexSession);
    if (!sessionId || (sessions.length && sessions.some(id => id !== sessionId))) continue;
    if (state.task.session_id !== sessionId) continue;
    const end = Date.parse(state.task.completed_at ?? state.task.failed_at ?? state.task.cancelled_at);
    const start = Date.parse(state.task.started_at);
    const evidence = native.filter(unit => unit.provider === state.task.provider && unit.providerSessionId === sessionId && unit.providerRequestId && validNativeRequest(unit)
      && Date.parse(unit.occurredAt) >= start && Date.parse(unit.occurredAt) < end);
    if (!evidence.length) continue;
    // An inferred namespace is safe only if every supplied request already has
    // a single canonical same-run owner. It does not authorize missing requests.
    if (!explicit && !legacyCodexSession && evidence.some(unit => main.filter(old => old.providerRequestId === unit.providerRequestId && old.provider === unit.provider).length !== 1)) continue;
    if (evidence.some(unit => state.units.some(row => row.run_id !== run.run_id && row.provider_session_id === sessionId && row.provider_request_id === unit.providerRequestId))) continue;
    const correctedRequestIds: string[] = [];
    let gained = 0;
    // A partial archive never proves that every old unknown meter observation
    // is covered. Retain them as unknown alongside the recovered subtotal.
    const proofs = completedTurns.filter(proof => proof.providerSessionId === sessionId && Date.parse(proof.completedAt) >= start && Date.parse(proof.completedAt) < end);
    const fullProof = proofs.length === 1 && typeof proofs[0]!.turnId === "string" && proofs[0]!.turnId.length > 0
      && !!proofs[0]!.completionEvidenceRef && !!proofs[0]!.totalsEvidenceRef && !!proofs[0]!.startEvidenceRef
      && Date.parse(proofs[0]!.startedAt) >= start && Date.parse(proofs[0]!.startedAt) <= Date.parse(proofs[0]!.completedAt)
      && Number.isSafeInteger(proofs[0]!.totalTokens) && proofs[0]!.totalTokens >= 0
      && evidence.length === proofs[0]!.responseIds.length
      && new Set(proofs[0]!.responseIds).size === evidence.length
      && evidence.every(unit => proofs[0]!.responseIds.includes(unit.providerRequestId!))
      && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every(key => Number.isSafeInteger((proofs[0] as any)[key]) && (proofs[0] as any)[key] >= 0
        && evidence.reduce((sum, unit) => sum + (unit as any)[key], 0) === (proofs[0] as any)[key])
      && evidence.reduce((sum, unit) => sum + unitActualTotal(unit), 0) === proofs[0]!.totalTokens;
    const supersededUnitIds: string[] = legacyCodexSession && fullProof ? main.filter(unit => unresolvedCodexSession(unit, sessionId)
      && ["provider_timestamp", "observed_at"].includes(unit.timeProvenance ?? "observed_at")
      && Date.parse(unit.occurredAt) >= Date.parse(proofs[0]!.startedAt) && Date.parse(unit.occurredAt) <= Date.parse(proofs[0]!.completedAt)).map(unit => unit.unitId) : [];
    const updated = units.filter(unit => !supersededUnitIds.includes(unit.unitId));
    const revision = Math.max(Number(run.revision), ...state.receipts.filter(row => row.run_id === run.run_id).map(row => Number(row.revision)), ...units.map(unit => unit.revision)) + 1;
    for (const unit of evidence) {
      const index = updated.findIndex(old => (old.purpose ?? "agent") === "agent" && old.provider === unit.provider && old.providerSessionId === sessionId && old.providerRequestId === unit.providerRequestId);
      const old = index < 0 ? null : updated[index]!;
      if (old && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].some(key => (old as any)[key] != null && (unit as any)[key] < (old as any)[key])) continue;
      if (old && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every(key => (old as any)[key] === (unit as any)[key]) && old.accuracy === "exact") continue;
      const next = { ...(old ?? unit), revision, inputTokens: unit.inputTokens, outputTokens: unit.outputTokens,
        cacheReadTokens: unit.cacheReadTokens, cacheWriteTokens: unit.cacheWriteTokens, actualUnsplitTokens: 0,
        reportedTotalTokens: unit.reportedTotalTokens, accuracy: "exact" as const, evidenceRef: unit.evidenceRef,
        ...(unit.model ? { model: unit.model, modelSource: unit.modelSource } : {}) };
      if (!old) {
        // Preserve the evidenced connection only when the run has one route.
        const connections = [...new Set(main.map(value => value.connectionId).filter(Boolean))];
        if (connections.length > 1) continue;
        if (connections.length) next.connectionId = connections[0];
        updated.push(next);
      } else updated[index] = next;
      gained += unitActualTotal(next) - (old ? unitActualTotal(old) : 0);
      correctedRequestIds.push(unit.providerRequestId!);
    }
    if (!correctedRequestIds.length && !supersededUnitIds.length) continue;
    const retiredRemainderIds: string[] = [];
    const remainders = units.filter(unit => (unit.purpose ?? "agent") === "agent" && unit.evidenceRef === "acp_prompt_unattributed_remainder" && unit.actualUnsplitTokens != null);
    // Equality is corroborating coverage, never identity: all prior requests
    // must be matched in this session and the single settlement gap explained.
    if (remainders.length === 1 && remainders[0]!.actualUnsplitTokens === gained && main.length > 0
      && main.every(old => old.providerSessionId === sessionId && old.providerRequestId && evidence.some(unit => unit.provider === old.provider
        && unit.providerSessionId === old.providerSessionId && unit.providerRequestId === old.providerRequestId))) {
      const remainder = remainders[0]!;
      const index = updated.findIndex(unit => unit.unitId === remainder.unitId);
      updated.splice(index, 1);
      supersededUnitIds.push(remainder.unitId);
      retiredRemainderIds.push(remainder.unitId);
    } else if (remainders.length && gained > 0) continue; // Cannot safely add atop an unexplained gap.
    for (let index = 0; index < updated.length; index++) {
      const unit = updated[index]!;
      if (!unit.coveredUnitIds?.some(id => supersededUnitIds.includes(id))) continue;
      // Existing charge allocations remain untouched unless they explicitly
      // covered every replaced main request. A partial allocation is ambiguous.
      if ((unit.purpose ?? "agent") !== "agent" || !main.every(old => unit.coveredUnitIds!.includes(old.unitId))) return [];
      const replacementIds = updated.filter(value => (value.purpose ?? "agent") === "agent" && value.source === "provider_request").map(value => value.unitId);
      updated[index] = { ...unit, revision, coveredUnitIds: [...new Set([...unit.coveredUnitIds.filter(id => !supersededUnitIds.includes(id)), ...replacementIds])].sort(),
        coverageExpectedCount: undefined, coverageSha256: undefined };
    }
    const scope = explicit ?? { taskId: state.task.id, runId: run.run_id, providerSessionId: sessionId, evidenceRef: "canonical_request_namespace" };
    repairs.push({ taskId: state.task.id, expectedStateSha256: modernStateHash(state), scope,
      snapshot: { version: 2, runId: run.run_id, revision, complete: Number(run.complete) === 1, units: updated },
      beforeActualTokens: units.reduce((sum, unit) => sum + unitActualTotal(unit), 0), afterActualTokens: updated.reduce((sum, unit) => sum + unitActualTotal(unit), 0),
      correctedRequestIds, retiredRemainderIds, supersededUnitIds, nativeEvidence: evidence,
      coverage: legacyCodexSession && fullProof ? "complete_native_turn" : "partial", completedTurns: proofs });
  }
  // One task checkpoint avoids applying a second run against a stale task hash.
  return repairs.length === 1 ? repairs : [];
}

export function applyModernUsageRepairs(db: SqlDatabase, repairs: ModernUsageRepair[], checksum: string): { applied: number; resumed: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_modern_repair_audit(task_id TEXT NOT NULL,plan_checksum TEXT NOT NULL,original_state TEXT NOT NULL,result_state_sha256 TEXT NOT NULL,PRIMARY KEY(task_id,plan_checksum),FOREIGN KEY(task_id) REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE)`);
  let applied = 0, resumed = 0;
  for (const repair of repairs) {
    const changed = db.transaction(() => {
      if (db.query("SELECT task_id FROM multiremi_usage_modern_repair_audit WHERE task_id=? AND plan_checksum=?").get(repair.taskId, checksum)) return false;
      const initial = readModernRepairState(db, repair.taskId);
      if (!initial.task) throw new Error("Modern repair task missing");
      db.run("UPDATE multiremi_workspaces SET updated_at=updated_at WHERE id=?", [initial.task.workspace_id]);
      markRequestReadCacheLockTaken();
      lockUsageIdentities(db, initial.task.workspace_id, repair.snapshot.units);
      db.query(`SELECT a.id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id
        WHERE a.id=?${db.dialect === "postgres" ? " FOR UPDATE OF t,a" : ""}`).get(repair.taskId);
      const state = readModernRepairState(db, repair.taskId);
      if (!terminal(state.task.status) || modernStateHash(state) !== repair.expectedStateSha256) throw new Error("Modern usage changed after plan; regenerate reviewed plan");
      if (repair.scope.taskId !== repair.taskId || repair.scope.runId !== repair.snapshot.runId || !repair.scope.evidenceRef || !repair.scope.providerSessionId) throw new Error("Invalid modern repair scope");
      if (!state.runs.some(run => run.run_id === repair.snapshot.runId) || ["legacy", "historical-evidence-v2"].includes(repair.snapshot.runId)) throw new Error("Modern repair requires an existing live run");
      const regenerated = buildModernUsageRepairs(state, repair.nativeEvidence, repair.scope.evidenceRef === "canonical_request_namespace" ? [] : [repair.scope], repair.completedTurns);
      if (regenerated.length !== 1 || sha(regenerated[0]) !== sha(repair)) throw new Error("Modern repair evidence does not reproduce reviewed correction");
      if (repair.snapshot.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== repair.afterActualTokens) throw new Error("Modern repair totals mismatch");
      for (const unitId of repair.supersededUnitIds) {
        if (!state.receipts.some(receipt => receipt.run_id === repair.snapshot.runId && receipt.unit_id === unitId)) throw new Error("Modern repair supersession requires a persisted receipt");
        db.run("UPDATE multiremi_usage_unit_receipts SET revision=?,disposition='superseded' WHERE task_id=? AND run_id=? AND unit_id=?", [repair.snapshot.revision, repair.taskId, repair.snapshot.runId, unitId]);
        db.run("DELETE FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id=? AND monetary_unit_id=?", [repair.taskId, repair.snapshot.runId, unitId]);
        db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id=? AND unit_id=?", [repair.taskId, repair.snapshot.runId, unitId]);
      }
      for (let offset = 0; offset < repair.snapshot.units.length; offset += 500) writeUsageSnapshot(db, repair.taskId, { ...repair.snapshot, units: repair.snapshot.units.slice(offset, offset + 500) }, { historical: true, identityLocksHeld: true });
      const result = readModernRepairState(db, repair.taskId);
      const actual = result.units.filter(row => row.run_id === repair.snapshot.runId).map(row => storedUsageUnit(row, result.coverage));
      if (actual.length !== repair.snapshot.units.length || actual.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== repair.afterActualTokens) throw new Error("Modern repair canonical ownership mismatch");
      db.run("INSERT INTO multiremi_usage_modern_repair_audit(task_id,plan_checksum,original_state,result_state_sha256) VALUES(?,?,?,?)", [repair.taskId, checksum, JSON.stringify(state), modernStateHash(result)]);
      return true;
    })();
    if (changed) applied++; else resumed++;
  }
  return { applied, resumed };
}
export function verifyModernUsageRepairs(db: SqlDatabase, repairs: ModernUsageRepair[], checksum: string): number {
  for (const repair of repairs) {
    const audit = db.query("SELECT result_state_sha256 FROM multiremi_usage_modern_repair_audit WHERE task_id=? AND plan_checksum=?").get(repair.taskId, checksum) as Row | null;
    if (!audit || audit.result_state_sha256 !== modernStateHash(readModernRepairState(db, repair.taskId))) throw new Error("Modern repair verification mismatch");
  }
  return repairs.length;
}
