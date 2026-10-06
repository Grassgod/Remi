import { createHash } from "node:crypto";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { legacyUsageSnapshot, validateUsageSnapshot, writeUsageSnapshot } from "../packages/server/src/store/usage-accounting.js";
import type { ReconcileUsagePlan } from "./reconcile-task-usage.js";
import { unitActualTotal } from "../packages/acp/src/usage-collector.js";

export const usagePlanChecksum = (plan: ReconcileUsagePlan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

/** Every task is one atomic checkpoint; the audit preserves replaced facts. */
export function applyUsageReconciliation(db: SqlDatabase, plan: ReconcileUsagePlan,
  onProgress?: (progress: { processed: number; applied: number; resumed: number }) => void): { applied: number; resumed: number; checksum: string } {
  if (plan.version !== 2 || plan.mode !== "read-only" || !Array.isArray(plan.tasks)) throw new Error("Invalid reconciliation plan");
  const checksum = usagePlanChecksum(plan);
  const seen = new Set<string>();
  for (const item of plan.tasks) {
    if (seen.has(item.taskId) || item.snapshot.runId !== "historical-evidence-v2" || typeof item.supersedeLegacyRun !== "boolean"
      || !/^[a-f0-9]{64}$/.test(item.expectedLegacyUsageSha256)) throw new Error("Invalid reconciliation task");
    seen.add(item.taskId);
    const ids = new Set(item.snapshot.units.map(unit => unit.unitId));
    if (ids.size !== item.snapshot.units.length || item.snapshot.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== item.actualTokens) throw new Error("Reconciliation totals or identities do not match");
    if (item.supersedeLegacyRun && !item.snapshot.units.some(unit => unitActualTotal(unit) > 0)) throw new Error("Cannot supersede legacy consumption without better actual evidence");
    if (item.coverage !== "partial" && item.coverage !== "none") throw new Error("Unproven reconciliation coverage");
    if (item.supersedeLegacyRun && item.legacyKnownTokens > 0) throw new Error("Partial evidence cannot supersede known legacy consumption");
    if (item.countedActualTokens !== (item.legacyKnownTokens === 0 ? item.actualTokens : 0)) throw new Error("Partial evidence cannot be added to a known legacy aggregate");
    for (let offset = 0; offset < item.snapshot.units.length; offset += 500) validateUsageSnapshot({ ...item.snapshot, units: item.snapshot.units.slice(offset, offset + 500) });
  }
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_reconciliation_audit (
    task_id TEXT NOT NULL, plan_checksum TEXT NOT NULL, original_units TEXT NOT NULL, original_runs TEXT NOT NULL,
    legacy_usage_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, recovered_actual_tokens BIGINT NOT NULL,
    PRIMARY KEY(task_id,plan_checksum), FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_reconciliation_evidence (
    task_id TEXT NOT NULL, plan_checksum TEXT NOT NULL, units_json TEXT NOT NULL,
    PRIMARY KEY(task_id,plan_checksum), FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
  )`);
  let applied = 0, resumed = 0, processed = 0;
  for (const item of plan.tasks) {
    const changed = db.transaction(() => {
      const prior = db.query("SELECT task_id FROM multiremi_usage_reconciliation_audit WHERE task_id=? AND plan_checksum=?").get(item.taskId, checksum);
      if (prior) return false;
      const task = db.query(`SELECT usage,status,COALESCE(completed_at,failed_at,cancelled_at,started_at,dispatched_at,updated_at,created_at) AS occurred_at
        FROM multiremi_tasks WHERE id=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(item.taskId) as { usage: string | null; status: string; occurred_at: string } | null;
      if (!task) throw new Error(`Reconciliation task missing: ${item.taskId}`);
      const current = createHash("sha256").update(task.usage ?? "").digest("hex");
      if (current !== item.expectedLegacyUsageSha256) throw new Error(`Legacy usage changed after plan: ${item.taskId}`);
      if (!["completed", "failed", "cancelled"].includes(task.status)) throw new Error(`Historical cohort changed: task is not terminal ${item.taskId}`);
      const live = db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id NOT IN ('legacy','historical-evidence-v2') LIMIT 1").get(item.taskId);
      if (live) throw new Error(`Historical cohort changed: modern live usage exists for ${item.taskId}`);
      const legacy = legacyUsageSnapshot(item.taskId, task.usage, task.occurred_at);
      if (legacy.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0) !== item.legacyKnownTokens) throw new Error(`Legacy evidence total changed: ${item.taskId}`);
      const originalUnits = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2') ORDER BY run_id,unit_id").all(item.taskId);
      const originalRuns = db.query("SELECT * FROM multiremi_usage_runs WHERE task_id=? AND run_id IN ('legacy','historical-evidence-v2') ORDER BY run_id").all(item.taskId);
      // Partial evidence is a separate reconciliation record, never another
      // additive copy of a known aggregate. A previous rehearsal can be undone
      // from the unchanged, hashed original task record.
      const replacedRuns = item.supersedeLegacyRun ? "('legacy','historical-evidence-v2')" : "('historical-evidence-v2')";
      db.run(`DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      db.run(`DELETE FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      db.run(`DELETE FROM multiremi_usage_runs WHERE task_id=? AND run_id IN ${replacedRuns}`, [item.taskId]);
      if (!item.supersedeLegacyRun && !db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'").get(item.taskId)) {
        writeUsageSnapshot(db, item.taskId, legacy, { historical: true });
      }
      const countedUnits = item.legacyKnownTokens > 0 ? item.snapshot.units.filter(unit => unitActualTotal(unit) === 0) : item.snapshot.units;
      if (!countedUnits.length) writeUsageSnapshot(db, item.taskId, { ...item.snapshot, units: [] }, { historical: true });
      for (let offset = 0; offset < countedUnits.length; offset += 500) {
        writeUsageSnapshot(db, item.taskId, { ...item.snapshot, units: countedUnits.slice(offset, offset + 500) }, { historical: true });
      }
      db.run("INSERT INTO multiremi_usage_reconciliation_evidence(task_id,plan_checksum,units_json) VALUES(?,?,?)", [item.taskId, checksum, JSON.stringify(item.snapshot.units)]);
      db.run(`INSERT INTO multiremi_usage_reconciliation_audit(task_id,plan_checksum,original_units,original_runs,legacy_usage_sha256,applied_at,recovered_actual_tokens)
        VALUES(?,?,?,?,?,?,?)`, [item.taskId, checksum, JSON.stringify(originalUnits), JSON.stringify(originalRuns), current, new Date().toISOString(), item.actualTokens]);
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
    const stored = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? AND run_id=?").all(item.taskId, item.snapshot.runId) as Record<string, unknown>[];
    const indexed = new Map(stored.map(row => [row.unit_id, row]));
    const numeric = { revision: "revision", inputTokens: "input_tokens", outputTokens: "output_tokens", cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens", actualUnsplitTokens: "actual_unsplit_tokens", reportedTotalTokens: "reported_total_tokens", contextTokens: "context_tokens", contextWindow: "context_window", costAmount: "cost_amount" } as const;
    const strings = { provider: "provider", model: "model", modelSource: "model_source", purpose: "purpose", requestedModel: "requested_model", connectionId: "connection_id", scope: "scope", source: "source", accuracy: "accuracy", costCurrency: "cost_currency", costSource: "cost_source", occurredAt: "occurred_at", evidenceRef: "evidence_ref" } as const;
    for (const unit of countedUnits) {
      const row = indexed.get(unit.unitId);
      if (!row || Object.entries(numeric).some(([key, column]) => {
        const expected = (unit as any)[key] ?? null, actual = row[column];
        return expected === null ? actual !== null : actual === null || Number(actual) !== expected;
      }) || Object.entries(strings).some(([key, column]) => row[column] !== ((unit as any)[key] ?? (key === "modelSource" || key === "costSource" ? "unknown" : key === "purpose" ? "agent" : null)))) throw new Error(`Reconciliation evidence mismatch: ${item.taskId}`);
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
