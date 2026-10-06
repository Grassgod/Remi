import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { expect } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { migrateLegacyUsage, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { buildReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";

export async function assertRecoveryRevisions(store: MultiremiStore, db: SqlDatabase, taskId: string,
  copy?: () => SqlDatabase): Promise<void> {
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status='completed',usage=?,provider='claude',completed_at='2026-10-01T01:00:00Z' WHERE id=?",
    [JSON.stringify([{ provider: "claude", totalTokens: 70 }]), taskId]);
  migrateLegacyUsage(db);
  const sql = (handle: SqlDatabase) => ({ unsafe: async (statement: string, args: unknown[] = []) => handle.query(statement.replace(/\$\d+/g, "?")).all(...args) }) as unknown as Bun.SQL;
  const append = (id: string, inputTokens: number, outputTokens: number) => store.appendTaskMessages(taskId, [{ type: "usage", meta: { _meta: { remiTokenUsage: {
    id, providerSessionId: `revision-session:${taskId}`, model: "opus", inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens,
  } } } }]);
  append("retained", 10, 2);
  const first = await buildReconcileUsagePlan(sql(db), { taskId });
  expect(first.tasks[0]!.snapshot.units[0]!.revision).toBe(1);
  applyUsageReconciliation(db, first);
  expect(verifyUsageReconciliation(db, first).ledgerActualTokens).toBe(12);
  append("retained", 18, 2);
  const stronger = await buildReconcileUsagePlan(sql(db), { taskId });
  expect(stronger.tasks[0]!.snapshot.units[0]!.revision).toBe(2);
  expect(stronger.tasks[0]!.snapshot.units[0]!.providerRequestId).toBe("retained");
  applyUsageReconciliation(db, stronger);
  expect(verifyUsageReconciliation(db, stronger).ledgerActualTokens).toBe(20);
  expect(applyUsageReconciliation(db, stronger)).toMatchObject({ applied: 0, resumed: 1 });
  append("new", 4, 1);
  const added = await buildReconcileUsagePlan(sql(db), { taskId });
  expect(added.tasks[0]!.snapshot.units.map(unit => unit.revision).sort()).toEqual([1, 3]);
  applyUsageReconciliation(db, added);
  expect(verifyUsageReconciliation(db, added).ledgerActualTokens).toBe(25);
  if (copy) {
    const copied = copy();
    try {
      expect(applyUsageReconciliation(copied, added)).toMatchObject({ applied: 0, resumed: 1 });
      expect(verifyUsageReconciliation(copied, added).ledgerActualTokens).toBe(25);
      const regenerated = await buildReconcileUsagePlan(sql(copied), { taskId });
      expect(Math.max(...regenerated.tasks[0]!.snapshot.units.map(unit => unit.revision))).toBe(4);
      applyUsageReconciliation(copied, regenerated);
      expect(verifyUsageReconciliation(copied, regenerated).ledgerActualTokens).toBe(25);
    } finally { copied.close(); }
  }
  const stale = await buildReconcileUsagePlan(sql(db), { taskId });
  const prior = added.tasks[0]!.snapshot.units[0]!;
  writeUsageSnapshot(db, taskId, { ...added.tasks[0]!.snapshot, revision: 10,
    units: [{ ...prior, revision: 10 }] }, { historical: true });
  expect(() => applyUsageReconciliation(db, stale)).toThrow("Usage revision watermarks changed after plan");
  const renewed = await buildReconcileUsagePlan(sql(db), { taskId });
  expect(renewed.tasks[0]!.snapshot.units.find(unit => unit.unitId === prior.unitId)!.revision).toBe(11);
  applyUsageReconciliation(db, renewed);
  expect(verifyUsageReconciliation(db, renewed).ledgerActualTokens).toBe(25);
  // Removing source rows cannot use the new revision to withdraw known facts.
  db.run("DELETE FROM multiremi_task_messages WHERE task_id=? AND type='usage'", [taskId]);
  const narrow = await buildReconcileUsagePlan(sql(db), { taskId });
  expect(() => applyUsageReconciliation(db, narrow)).toThrow("Recovery plan would downgrade established evidence");
  expect(verifyUsageReconciliation(db, renewed).ledgerActualTokens).toBe(25);
}

export async function assertRecreatedLegacyReceipt(store: MultiremiStore, db: SqlDatabase, taskId: string): Promise<void> {
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status='completed',provider='claude',usage=?,completed_at='2026-10-01T01:00:00Z' WHERE id=?",
    [JSON.stringify([{ provider: "claude", inputTokens: 100, outputTokens: 2 }]), taskId]);
  migrateLegacyUsage(db);
  const previous = Number(db.query("SELECT revision FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id='legacy' AND unit_id='legacy:0'").get(taskId).revision);
  // A restored copy may retain durable receipts after provisional rows vanished.
  db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'", [taskId]);
  db.run("DELETE FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id='legacy'", [taskId]);
  db.run("DELETE FROM multiremi_usage_runs WHERE task_id=? AND run_id='legacy'", [taskId]);
  const sql = { unsafe: async (statement: string, args: unknown[] = []) => db.query(statement.replace(/\$\d+/g, "?")).all(...args) } as unknown as Bun.SQL;
  const plan = await buildReconcileUsagePlan(sql, { taskId });
  expect(plan.tasks[0]!.legacyRevision).toBeGreaterThan(previous);
  applyUsageReconciliation(db, plan);
  expect(verifyUsageReconciliation(db, plan).preservedLegacyTokens).toBe(102);
  expect(Number(db.query("SELECT revision FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id='legacy' AND unit_id='legacy:0'").get(taskId).revision)).toBe(plan.tasks[0]!.legacyRevision!);
  expect(applyUsageReconciliation(db, plan)).toMatchObject({ applied: 0, resumed: 1 });
  // The scalar source refresh must also advance above receipts retained by a
  // reviewed reconstruction, rather than reverting to its source version.
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [JSON.stringify([{ provider: "claude", inputTokens: 110, outputTokens: 2 }]), taskId]);
  expect(migrateLegacyUsage(db).complete).toBe(true);
  expect(Number(db.query("SELECT revision FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id='legacy' AND unit_id='legacy:0'").get(taskId).revision)).toBeGreaterThan(plan.tasks[0]!.legacyRevision!);
  expect(Number(db.query("SELECT input_tokens+output_tokens AS actual FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy' AND unit_id='legacy:0'").get(taskId).actual)).toBe(112);
}
