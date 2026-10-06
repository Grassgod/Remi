import { expect } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { actualUnit } from "@acp/usage-collector.js";
import { hasPendingLegacyUsage, migrateLegacyUsage, UsageValidationError, USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-accounting.js";
import { ensureUsageAccountingStartup } from "@multiremi/store/usage-migration.js";

export function assertLegacyHistoryBoundary(store: MultiremiStore, db: SqlDatabase, taskId: string): void {
  const old = [{ provider: "claude", model: "configured-opus", totalTokens: 70, inputTokens: 0, outputTokens: 0 }];
  const original = JSON.stringify(old);
  db.run("UPDATE multiremi_tasks SET status='completed',completed_at='2026-10-01T01:00:00Z',usage=? WHERE id=?", [original, taskId]);
  migrateLegacyUsage(db);
  store.reportTaskUsageSnapshot(taskId, { version: 2, runId: "historical-evidence-v2", revision: 1, complete: false,
    units: [actualUnit({ unitId: "native", provider: "claude", model: "opus", scope: "request", source: "provider_request",
      providerSessionId: `native:${taskId}`, providerRequestId: "request", inputTokens: 10, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 })] });
  const before = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(taskId);
  const receipts = db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(taskId);
  const checkpoint = db.query("SELECT * FROM multiremi_usage_legacy_sources WHERE task_id=?").get(taskId);
  const total = () => Number(db.query(`SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)) AS n
    FROM multiremi_usage_units WHERE task_id=?`).get(taskId).n);
  expect(total()).toBe(12);
  // Same obsolete snapshot is acknowledged without changing receipts or time.
  expect(store.reportTaskUsage(taskId, old).id).toBe(taskId);
  const currentJson = db.query("SELECT usage FROM multiremi_tasks WHERE id=?").get(taskId).usage;
  expect(currentJson).toBe(original);
  expect(() => store.reportTaskUsage(taskId, [{ provider: "claude", model: "configured-opus", inputTokens: 20, outputTokens: 0 }])).toThrow(UsageValidationError);
  expect(db.query("SELECT usage FROM multiremi_tasks WHERE id=?").get(taskId).usage).toBe(original);
  expect(total()).toBe(12);
  expect(db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(taskId)).toEqual(before);
  expect(db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(taskId)).toEqual(receipts);
  // An old deployed API can bypass the new ingestion guard and mutate JSON.
  const changed = JSON.stringify([{ provider: "claude", model: "configured-opus", inputTokens: 20, outputTokens: 0 }]);
  ensureUsageAccountingStartup(db);
  expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER)).not.toBeNull();
  db.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [changed, taskId]);
  // Real startup must invalidate an already-ready marker after an old-image
  // rollback, before it can open listeners or run background jobs.
  expect(() => ensureUsageAccountingStartup(db)).toThrow("Legacy usage changed after historical reconciliation");
  expect(hasPendingLegacyUsage(db)).toBe(true);
  expect(db.query("SELECT * FROM multiremi_usage_legacy_sources WHERE task_id=?").get(taskId)).toEqual(checkpoint);
  expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id IN (?,?)").all(USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER)).toEqual([]);
  const versions = db.query("SELECT source_version,original_usage FROM multiremi_usage_legacy_versions WHERE task_id=? ORDER BY source_version").all(taskId);
  expect(versions.at(-1).original_usage).toBe(changed);
  expect(() => migrateLegacyUsage(db)).toThrow(UsageValidationError);
  expect(db.query("SELECT source_version,original_usage FROM multiremi_usage_legacy_versions WHERE task_id=? ORDER BY source_version").all(taskId)).toEqual(versions);
  expect(() => ensureUsageAccountingStartup(db)).toThrow(UsageValidationError);
  expect(db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(taskId)).toEqual(before);
  expect(total()).toBe(12);
  expect(db.query("SELECT usage FROM multiremi_tasks WHERE id=?").get(taskId).usage).toBe(changed);
  // Explicit fixture restoration is not an automatic repair; retain drift audit.
  db.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [original, taskId]);
  ensureUsageAccountingStartup(db);
  expect(hasPendingLegacyUsage(db)).toBe(false);
}

export function assertNonconsumingHistoryBoundary(store: MultiremiStore, db: SqlDatabase, taskId: string,
  kind: "empty_modern" | "empty_history" | "context_history"): void {
  db.run("UPDATE multiremi_tasks SET status='completed',completed_at='2026-10-01T01:00:00Z',usage=? WHERE id=?",
    [JSON.stringify([{ provider: "claude", totalTokens: 70 }]), taskId]);
  migrateLegacyUsage(db);
  store.reportTaskUsageSnapshot(taskId, { version: 2, runId: kind === "empty_modern" ? "start-only" : "historical-evidence-v2", revision: 1, complete: false,
    units: kind === "context_history" ? [{ ...actualUnit({ unitId: "context", provider: "claude", scope: "turn", source: "context_snapshot", accuracy: "unknown" }),
      contextTokens: 80000 }] : [] });
  // First test source refresh, then a deprecated report update at a higher floor.
  db.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [JSON.stringify([{ provider: "claude", inputTokens: 20, outputTokens: 0 }]), taskId]);
  expect(migrateLegacyUsage(db).complete).toBe(true);
  expect(hasPendingLegacyUsage(db)).toBe(false);
  store.reportTaskUsage(taskId, [{ provider: "claude", model: "unknown", inputTokens: 30, outputTokens: 0 }]);
  migrateLegacyUsage(db);
  expect(Number(db.query(`SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)) AS n
    FROM multiremi_usage_units WHERE task_id=?`).get(taskId).n)).toBe(30);
  if (kind === "context_history") expect(Number(db.query("SELECT context_tokens FROM multiremi_usage_units WHERE task_id=? AND unit_id='context'").get(taskId).context_tokens)).toBe(80000);
}
