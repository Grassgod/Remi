import { createHash } from "node:crypto";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { legacyUsageSnapshot, lockUsageIdentities, validateUsageSnapshot, writeUsageSnapshot } from "../packages/server/src/store/usage-accounting.js";
import { markRequestReadCacheLockTaken } from "../packages/server/src/store/request-read-cache.js";
import type { ReconcileUsagePlan } from "./reconcile-task-usage.js";
import { unitActualTotal } from "../packages/acp/src/usage-collector.js";
import { readUsageRevisionState, usageRevisionStateSha256 } from "./usage-reconciliation-revisions.js";

export const usagePlanChecksum = (plan: ReconcileUsagePlan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");
const coverageCommitment = (unit: ReconcileUsagePlan["tasks"][number]["snapshot"]["units"][number]) => ({
  count: unit.coverageExpectedCount ?? (unit.coveredUnitIds === undefined ? null : unit.coveredUnitIds.length),
  hash: unit.coverageSha256 ?? (unit.coveredUnitIds === undefined ? null
    : createHash("sha256").update(JSON.stringify([...unit.coveredUnitIds].sort())).digest("hex")),
});
const meterJson = (unit: ReconcileUsagePlan["tasks"][number]["snapshot"]["units"][number]) => {
  const meter = unit.meterEvidence;
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
  return meter ? JSON.stringify({ epochId: meter.epochId, before: fields.map(key => meter.before[key]),
    after: fields.map(key => meter.after[key]), last: meter.last ? fields.map(key => meter.last![key]) : null }) : null;
};

/** Every task is one atomic checkpoint; the audit preserves replaced facts. */
export function applyUsageReconciliation(db: SqlDatabase, plan: ReconcileUsagePlan,
  onProgress?: (progress: { processed: number; applied: number; resumed: number }) => void): { applied: number; resumed: number; checksum: string } {
  if (plan.version !== 2 || plan.mode !== "read-only" || !Array.isArray(plan.tasks)) throw new Error("Invalid reconciliation plan");
  const checksum = usagePlanChecksum(plan);
  const seen = new Set<string>();
  for (const item of plan.tasks) {
    if (seen.has(item.taskId) || item.snapshot.runId !== "historical-evidence-v2" || typeof item.supersedeLegacyRun !== "boolean"
      || !/^[a-f0-9]{64}$/.test(item.expectedLegacyUsageSha256)) throw new Error("Invalid reconciliation task");
    if (item.expectedRevisionStateSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(item.expectedRevisionStateSha256)
      || !Number.isSafeInteger(item.legacyRevision) || item.legacyRevision! < 1 || item.legacyRevision! > 2_147_483_647)) throw new Error("Invalid reconciliation revision state");
    seen.add(item.taskId);
    const ids = new Set(item.snapshot.units.map(unit => unit.unitId));
    if (ids.size !== item.snapshot.units.length || item.snapshot.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== item.actualTokens) throw new Error("Reconciliation totals or identities do not match");
    if (item.supersedeLegacyRun && !item.snapshot.units.some(unit => unitActualTotal(unit) > 0)) throw new Error("Cannot supersede legacy consumption without better actual evidence");
    if (item.coverage !== "partial" && item.coverage !== "none") throw new Error("Unproven reconciliation coverage");
    if (item.supersedeLegacyRun && item.legacyKnownTokens > 0) throw new Error("Partial evidence cannot supersede known legacy consumption");
    if (item.countedActualTokens !== (item.legacyKnownTokens === 0 ? item.actualTokens : 0)) throw new Error("Partial evidence cannot be added to a known legacy aggregate");
    for (let offset = 0; offset < item.snapshot.units.length; offset += 500) validateUsageSnapshot({ ...item.snapshot, units: item.snapshot.units.slice(offset, offset + 500) });
    for (const evidence of item.attributionEvidence ?? []) {
      if (!["missing_request_namespace", "competing_request_owners"].includes(evidence.reason) || !Array.isArray(evidence.competingTaskIds)) throw new Error("Invalid reconciliation attribution evidence");
      validateUsageSnapshot({ ...item.snapshot, units: [evidence.unit] });
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_reconciliation_audit (
    task_id TEXT NOT NULL, plan_checksum TEXT NOT NULL, original_units TEXT NOT NULL, original_runs TEXT NOT NULL,
    legacy_usage_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, recovered_actual_tokens BIGINT NOT NULL,
    PRIMARY KEY(task_id,plan_checksum), FOREIGN KEY(task_id) REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_reconciliation_evidence (
    task_id TEXT NOT NULL, plan_checksum TEXT NOT NULL, units_json TEXT NOT NULL,
    PRIMARY KEY(task_id,plan_checksum), FOREIGN KEY(task_id) REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_reconciliation_attribution (
    task_id TEXT NOT NULL, plan_checksum TEXT NOT NULL, evidence_json TEXT NOT NULL,
    PRIMARY KEY(task_id,plan_checksum), FOREIGN KEY(task_id) REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE
  )`);
  let applied = 0, resumed = 0, processed = 0;
  for (const item of plan.tasks) {
    const changed = db.transaction(() => {
      const prior = db.query("SELECT task_id FROM multiremi_usage_reconciliation_audit WHERE task_id=? AND plan_checksum=?").get(item.taskId, checksum);
      if (prior) return false;
      const initial = db.query("SELECT workspace_id FROM multiremi_turn_execution_records WHERE id=?").get(item.taskId) as { workspace_id: string } | null;
      if (!initial) throw new Error(`Reconciliation task missing: ${item.taskId}`);
      db.run("UPDATE multiremi_workspaces SET updated_at=updated_at WHERE id=?", [initial.workspace_id]);
      markRequestReadCacheLockTaken();
      const countedUnits = item.legacyKnownTokens > 0 ? item.snapshot.units.filter(unit => unitActualTotal(unit) === 0) : item.snapshot.units;
      lockUsageIdentities(db, initial.workspace_id, countedUnits);
      const task = db.query(`SELECT workspace_id,usage,status,COALESCE(completed_at,failed_at,cancelled_at,started_at,dispatched_at,updated_at,created_at) AS occurred_at
        FROM multiremi_turn_execution_records WHERE id=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(item.taskId) as { workspace_id: string; usage: string | null; status: string; occurred_at: string } | null;
      if (!task) throw new Error(`Reconciliation task missing: ${item.taskId}`);
      if (task.workspace_id !== initial.workspace_id) throw new Error(`Historical workspace changed: ${item.taskId}`);
      const current = createHash("sha256").update(task.usage ?? "").digest("hex");
      if (current !== item.expectedLegacyUsageSha256) throw new Error(`Legacy usage changed after plan: ${item.taskId}`);
      if (!["completed", "failed", "cancelled"].includes(task.status)) throw new Error(`Historical cohort changed: task is not terminal ${item.taskId}`);
      const live = db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id NOT IN ('legacy','historical-evidence-v2') LIMIT 1").get(item.taskId);
      if (live) throw new Error(`Historical cohort changed: modern live usage exists for ${item.taskId}`);
      const legacy = legacyUsageSnapshot(item.taskId, task.usage, task.occurred_at);
      if (legacy.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== item.legacyKnownTokens) throw new Error(`Legacy evidence total changed: ${item.taskId}`);
      const revisionState = readUsageRevisionState(db, item.taskId);
      if (item.legacyRevision !== undefined) {
        legacy.revision = item.legacyRevision;
        for (const unit of legacy.units) unit.revision = item.legacyRevision;
      }
      const originalUnits = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2') ORDER BY run_id,unit_id").all(item.taskId) as Record<string, any>[];
      const originalRuns = db.query("SELECT * FROM multiremi_usage_runs WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2') ORDER BY run_id").all(item.taskId);
      const originalCoverage = db.query("SELECT * FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2') ORDER BY run_id,monetary_unit_id,covered_unit_id").all(item.taskId) as Record<string, any>[];
      const replacement = new Map(countedUnits.map(unit => [unit.unitId, unit]));
      // A narrower scan is not proof that an established request disappeared.
      // Replacement must retain every identity and each already known counter.
      // Corrections that withdraw prior facts require separate reviewed evidence.
      const counters = { input_tokens: "inputTokens", output_tokens: "outputTokens", cache_read_tokens: "cacheReadTokens",
        cache_write_tokens: "cacheWriteTokens", actual_unsplit_tokens: "actualUnsplitTokens", reported_total_tokens: "reportedTotalTokens",
        context_tokens: "contextTokens", cost_amount: "costAmount" } as const;
      for (const row of originalUnits.filter(row => row.run_id === "historical-evidence-v2")) {
        const next = replacement.get(row.unit_id);
        const coverage = next ? coverageCommitment(next) : null;
        if (!next || Object.entries(counters).some(([column, key]) => row[column] !== null
          && ((next as any)[key] == null || Number((next as any)[key]) < Number(row[column])))
          || ["provider", "scope", "source", "model", "requested_model", "connection_id", "provider_session_id", "provider_request_id", "provider_observation_id", "identity_kind", "cost_currency", "cost_source", "purpose", "occurred_at"].some(column => {
            const key = ({ requested_model: "requestedModel", connection_id: "connectionId", provider_session_id: "providerSessionId", provider_request_id: "providerRequestId", provider_observation_id: "providerObservationId", identity_kind: "identityKind", cost_currency: "costCurrency", cost_source: "costSource", occurred_at: "occurredAt" } as Record<string, string>)[column] ?? column;
            return row[column] != null && row[column] !== ((next as any)[key] ?? (column === "cost_source" ? "unknown" : column === "purpose" ? "agent" : null));
          }) || ({ unknown: 0, partial: 1, exact: 2 }[next.accuracy] < ({ unknown: 0, partial: 1, exact: 2 } as Record<string, number>)[row.accuracy]!)
          || (row.meter_evidence != null && row.meter_evidence !== meterJson(next))
          || (row.model_source != null && row.model_source !== "unknown" && next.modelSource !== row.model_source)
          || originalCoverage.some(link => link.run_id === "historical-evidence-v2" && link.monetary_unit_id === row.unit_id
            && !next.coveredUnitIds?.includes(link.covered_unit_id))
          || (row.cost_coverage_expected_count != null && (coverage!.count === null || coverage!.count < Number(row.cost_coverage_expected_count)
            || (coverage!.count === Number(row.cost_coverage_expected_count) && coverage!.hash !== row.cost_coverage_sha256)))
          || (Number(row.cost_coverage_complete) === 1 && coverage!.count !== null && (next.coveredUnitIds?.length ?? 0) !== coverage!.count)) {
          throw new Error(`Recovery plan would downgrade established evidence: ${item.taskId}`);
        }
      }
      if (item.expectedRevisionStateSha256 !== undefined && usageRevisionStateSha256(revisionState) !== item.expectedRevisionStateSha256) {
        throw new Error(`Usage revision watermarks changed after plan; regenerate reviewed plan: ${item.taskId}`);
      }
      if (item.expectedRevisionStateSha256 === undefined && revisionState.receipts.some(row => row.run_id === "historical-evidence-v2")) {
        throw new Error(`Recovery plan predates persisted revision watermarks; regenerate reviewed plan: ${item.taskId}`);
      }
      // Partial evidence stays separate from a known aggregate. Rebuilding a
      // verified superset preserves identities and audits the preceding facts.
      const replacedRuns = item.supersedeLegacyRun ? "('legacy','historical-evidence-v2')" : "('historical-evidence-v2')";
      db.run(`DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      db.run(`DELETE FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      db.run(`DELETE FROM multiremi_usage_runs WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      if (!item.supersedeLegacyRun && !db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(item.taskId)) {
        writeUsageSnapshot(db, item.taskId, legacy, { historical: true, identityLocksHeld: true });
      }
      if (!countedUnits.length) writeUsageSnapshot(db, item.taskId, { ...item.snapshot, units: [] }, { historical: true, identityLocksHeld: true });
      for (let offset = 0; offset < countedUnits.length; offset += 500) {
        writeUsageSnapshot(db, item.taskId, { ...item.snapshot, units: countedUnits.slice(offset, offset + 500) }, { historical: true, identityLocksHeld: true });
      }
      const canonical = db.query(`SELECT COUNT(*) AS units,COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)),0) AS actual
        FROM multiremi_usage_units WHERE task_id=? AND run_id=?`).get(item.taskId, item.snapshot.runId) as { units: number | string; actual: number | string };
      if (Number(canonical.units) !== countedUnits.length || Number(canonical.actual) !== item.countedActualTokens) throw new Error(`Canonical ownership changed after plan: ${item.taskId}`);
      db.run("INSERT INTO multiremi_usage_reconciliation_evidence(task_id,plan_checksum,units_json) VALUES(?,?,?)", [item.taskId, checksum, JSON.stringify(item.snapshot.units)]);
      db.run("INSERT INTO multiremi_usage_reconciliation_attribution(task_id,plan_checksum,evidence_json) VALUES(?,?,?)", [item.taskId, checksum, JSON.stringify(item.attributionEvidence ?? [])]);
      db.run(`INSERT INTO multiremi_usage_reconciliation_audit(task_id,plan_checksum,original_units,original_runs,legacy_usage_sha256,applied_at,recovered_actual_tokens)
        VALUES(?,?,?,?,?,?,?)`, [item.taskId, checksum, JSON.stringify(originalUnits.map(row => ({ ...row,
          covered_unit_ids: originalCoverage.filter(link => link.run_id === row.run_id && link.monetary_unit_id === row.unit_id).map(link => link.covered_unit_id),
        }))), JSON.stringify(originalRuns), current, new Date().toISOString(), item.actualTokens]);
      return true;
    })();
    if (changed) applied++; else resumed++;
    processed++;
    if (processed % 100 === 0 || processed === plan.tasks.length) onProgress?.({ processed, applied, resumed });
  }
  return { applied, resumed, checksum };
}

export function verifyUsageReconciliation(db: SqlDatabase, plan: ReconcileUsagePlan): {
  checksum: string; tasks: number; units: number; actualTokens: number; preservedLegacyTokens: number; ledgerActualTokens: number; unknownTasks: number;
} {
  const checksum = usagePlanChecksum(plan);
  let units = 0, actualTokens = 0, preservedLegacyTokens = 0, unknownTasks = 0;
  for (const item of plan.tasks) {
    const audit = db.query("SELECT task_id FROM multiremi_usage_reconciliation_audit WHERE task_id=? AND plan_checksum=?").get(item.taskId, checksum);
    if (!audit) throw new Error(`Reconciliation checkpoint missing: ${item.taskId}`);
    const result = db.query(`SELECT COUNT(*) AS units,COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)),0) AS actual
      FROM multiremi_usage_units WHERE task_id=? AND run_id=?`).get(item.taskId, item.snapshot.runId) as { units: number | string; actual: number | string };
    const countedUnits = item.legacyKnownTokens > 0 ? item.snapshot.units.filter(unit => unitActualTotal(unit) === 0) : item.snapshot.units;
    if (Number(result.units) !== countedUnits.length || Number(result.actual) !== item.countedActualTokens) throw new Error(`Reconciliation mismatch: ${item.taskId}`);
    const evidence = db.query("SELECT units_json FROM multiremi_usage_reconciliation_evidence WHERE task_id=? AND plan_checksum=?").get(item.taskId, checksum) as { units_json: string } | null;
    if (!evidence || evidence.units_json !== JSON.stringify(item.snapshot.units)) throw new Error(`Reconciliation evidence mismatch: ${item.taskId}`);
    if (item.attributionEvidence !== undefined) {
      const attribution = db.query("SELECT evidence_json FROM multiremi_usage_reconciliation_attribution WHERE task_id=? AND plan_checksum=?").get(item.taskId, checksum) as { evidence_json: string } | null;
      if (!attribution || attribution.evidence_json !== JSON.stringify(item.attributionEvidence)) throw new Error(`Reconciliation attribution mismatch: ${item.taskId}`);
    }
    const stored = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? AND run_id=?").all(item.taskId, item.snapshot.runId) as Record<string, unknown>[];
    const indexed = new Map(stored.map(row => [row.unit_id, row]));
    const coverage = new Map<string, string[]>();
    for (const link of db.query("SELECT monetary_unit_id,covered_unit_id FROM multiremi_usage_cost_coverage WHERE task_id=? AND run_id=? ORDER BY monetary_unit_id,covered_unit_id")
      .all(item.taskId, item.snapshot.runId) as { monetary_unit_id: string; covered_unit_id: string }[]) {
      const ids = coverage.get(link.monetary_unit_id) ?? [];
      ids.push(link.covered_unit_id);
      coverage.set(link.monetary_unit_id, ids);
    }
    const numeric = { revision: "revision", inputTokens: "input_tokens", outputTokens: "output_tokens", cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens", actualUnsplitTokens: "actual_unsplit_tokens", reportedTotalTokens: "reported_total_tokens", contextTokens: "context_tokens", contextWindow: "context_window", costAmount: "cost_amount" } as const;
    const strings = { provider: "provider", model: "model", modelSource: "model_source", purpose: "purpose", requestedModel: "requested_model", connectionId: "connection_id", providerSessionId: "provider_session_id", providerRequestId: "provider_request_id", providerObservationId: "provider_observation_id", identityKind: "identity_kind", timeProvenance: "time_provenance", scope: "scope", source: "source", accuracy: "accuracy", costCurrency: "cost_currency", costSource: "cost_source", occurredAt: "occurred_at", evidenceRef: "evidence_ref" } as const;
    for (const unit of countedUnits) {
      const row = indexed.get(unit.unitId);
      const commitment = coverageCommitment(unit);
      if (!row || Object.entries(numeric).some(([key, column]) => {
        const expected = (unit as any)[key] ?? null, actual = row[column];
        return expected === null ? actual !== null : actual === null || Number(actual) !== expected;
      }) || Object.entries(strings).some(([key, column]) => row[column] !== ((unit as any)[key] ?? (key === "modelSource" || key === "costSource" ? "unknown" : key === "purpose" ? "agent" : key === "timeProvenance" ? "observed_at" : null)))
        || JSON.stringify(coverage.get(unit.unitId) ?? []) !== JSON.stringify([...(unit.coveredUnitIds ?? [])].sort())
        || (row.cost_coverage_expected_count === null ? commitment.count !== null : Number(row.cost_coverage_expected_count) !== commitment.count)
        || row.cost_coverage_sha256 !== commitment.hash
        || row.meter_evidence !== meterJson(unit)
        || Number(row.cost_coverage_complete) !== (commitment.count === null || commitment.count === (unit.coveredUnitIds?.length ?? 0) ? 1 : 0)) {
        throw new Error(`Reconciliation evidence mismatch: ${item.taskId}`);
      }
    }
    const legacy = db.query(`SELECT COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)),0) AS actual
      FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'`).get(item.taskId) as { actual: number | string };
    const expectedLegacy = item.supersedeLegacyRun ? 0 : item.legacyKnownTokens;
    if (Number(legacy.actual) !== expectedLegacy) throw new Error(`Legacy source preservation mismatch: ${item.taskId}`);
    preservedLegacyTokens += Number(legacy.actual);
    units += Number(result.units); actualTokens += Number(result.actual);
    if (item.unrecoverableReason) unknownTasks++;
  }
  return { checksum, tasks: plan.tasks.length, units, actualTokens, preservedLegacyTokens, ledgerActualTokens: actualTokens + preservedLegacyTokens, unknownTasks };
}
