import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { expect } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { actualUnit } from "@acp/usage-collector.js";
import { hasPendingLegacyUsage, migrateLegacyUsage, UsageValidationError, USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-accounting.js";
import { ensureUsageAccountingStartup } from "@multiremi/store/usage-migration.js";

export function assertLegacyHistoryBoundary(store: MultiremiStore, db: SqlDatabase, taskId: string,
  runId = "historical-evidence-v2"): void {
  const old = runId === "historical-evidence-v2" ? [{ provider: "claude", model: "configured-opus", totalTokens: 70, inputTokens: 0, outputTokens: 0 }] : [];
  const original = JSON.stringify(old);
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status='completed',completed_at='2026-10-01T01:00:00Z',usage=? WHERE id=?", [original, taskId]);
  migrateLegacyUsage(db);
  store.reportTaskUsageSnapshot(taskId, { version: 2, runId, revision: 1, complete: false,
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
  const currentJson = db.query("SELECT usage FROM multiremi_turn_execution_records WHERE id=?").get(taskId).usage;
  expect(currentJson).toBe(original);
  expect(() => store.reportTaskUsage(taskId, [{ provider: "claude", model: "configured-opus", inputTokens: 20, outputTokens: 0 }])).toThrow(UsageValidationError);
  expect(db.query("SELECT usage FROM multiremi_turn_execution_records WHERE id=?").get(taskId).usage).toBe(original);
  expect(total()).toBe(12);
  expect(db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(taskId)).toEqual(before);
  expect(db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(taskId)).toEqual(receipts);
  // An old deployed API can bypass the new ingestion guard and mutate JSON.
  const changed = JSON.stringify([{ provider: "claude", model: "configured-opus", inputTokens: 20, outputTokens: 0 }]);
  ensureUsageAccountingStartup(db);
  expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER)).not.toBeNull();
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [changed, taskId]);
  // Real startup must invalidate an already-ready marker after an old-image
  // rollback, before it can open listeners or run background jobs.
  expect(() => ensureUsageAccountingStartup(db)).toThrow("Legacy usage changed after native accounting");
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
  expect(db.query("SELECT usage FROM multiremi_turn_execution_records WHERE id=?").get(taskId).usage).toBe(changed);
  // Explicit fixture restoration is not an automatic repair; retain drift audit.
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [original, taskId]);
  ensureUsageAccountingStartup(db);
  expect(hasPendingLegacyUsage(db)).toBe(false);
}

/** A legacy run from real ingress is not proof that a later observed JSON was accepted. */
export function assertRejectedAuditWithLegacyRun(store: MultiremiStore, db: SqlDatabase): void {
  ensureUsageAccountingStartup(db);
  const runtime = store.registerRuntime({ name: "legacy audit boundary", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "legacy audit boundary", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "synthetic legacy ingress", workspaceId: "local" });
  const old = [{ provider: "claude", model: "configured", totalTokens: 70, inputTokens: 0, outputTokens: 0 }];
  store.reportTaskUsage(task.id, old);
  const original = db.query("SELECT usage FROM multiremi_turn_execution_records WHERE id=?").get(task.id).usage;
  expect(db.query("SELECT task_id FROM multiremi_usage_legacy_sources WHERE task_id=?").get(task.id)).toBeNull();
  expect(db.query("SELECT task_id FROM multiremi_usage_legacy_audit WHERE task_id=?").get(task.id)).toBeNull();
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id, "accepted-native", runtime.id);
  store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "accepted-native", revision: 1, complete: false,
    units: [actualUnit({ unitId: "native", provider: "claude", model: "reported", scope: "request", source: "provider_request",
      providerSessionId: `native:${task.id}`, providerRequestId: "request", inputTokens: 10, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 })] });
  expect(store.reportTaskUsage(task.id, old).id).toBe(task.id);
  const changed = JSON.stringify([{ provider: "claude", model: "configured", inputTokens: 20, outputTokens: 0 }]);
  const facts = db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(task.id);
  const receipts = db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(task.id);
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [changed, task.id]);
  expect(() => store.reportTaskUsage(task.id, JSON.parse(changed))).toThrow(UsageValidationError);
  for (let restart = 0; restart < 2; restart++) {
    expect(() => ensureUsageAccountingStartup(db)).toThrow(UsageValidationError);
    expect(db.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(task.id)).toEqual(facts);
    expect(db.query("SELECT * FROM multiremi_usage_unit_receipts WHERE task_id=? ORDER BY run_id,unit_id").all(task.id)).toEqual(receipts);
    expect(db.query("SELECT task_id FROM multiremi_usage_legacy_sources WHERE task_id=?").get(task.id)).toBeNull();
    expect(db.query("SELECT original_usage FROM multiremi_usage_legacy_audit WHERE task_id=?").get(task.id)).toEqual({ original_usage: changed });
    expect(hasPendingLegacyUsage(db)).toBe(true);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id IN (?,?)").all(USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER)).toEqual([]);
    expect(Number(db.query("SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS n FROM multiremi_usage_units WHERE task_id=?").get(task.id).n)).toBe(12);
  }
  // Explicitly restore the fixture's accepted ingress snapshot. Its canonical
  // total-only facts prove equivalence, even though the first audit was rejected.
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [original, task.id]);
  ensureUsageAccountingStartup(db);
  expect(hasPendingLegacyUsage(db)).toBe(false);
  expect(db.query("SELECT source_usage FROM multiremi_usage_legacy_sources WHERE task_id=?").get(task.id)).toEqual({ source_usage: original });
  const totalOnly = db.query("SELECT reported_total_tokens,input_tokens FROM multiremi_usage_units WHERE task_id=? AND run_id='legacy'").get(task.id);
  expect(Number(totalOnly.reported_total_tokens)).toBe(70);
  expect(totalOnly.input_tokens).toBeNull();
  expect(store.reportTaskUsage(task.id, old).id).toBe(task.id);
}

/** Real Store failure recovery creates a second task ID for the next attempt. */
export async function assertRecordedV2RetryChain(store: MultiremiStore, db: SqlDatabase, startupWhileQueued: boolean): Promise<void> {
  const runtime = store.registerRuntime({ name: `native retry ${startupWhileQueued}`, provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: `native retry ${startupWhileQueued}`, provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const issue = store.createIssue({ title: "synthetic recovery", workspaceId: "local" });
  const parent = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "synthetic retry chain", workspaceId: "local", maxAttempts: 2 });
  expect(store.claimTask(runtime.id)?.id).toBe(parent.id);
  store.startTask(parent.id, "v2-parent", runtime.id);
  const snapshot = (taskId: string, runId: string, tokens: number) => ({ version: 2 as const, runId, revision: 1, complete: true,
    units: [actualUnit({ unitId: `native:${taskId}`, provider: "claude", model: "reported", scope: "request", source: "provider_request",
      providerSessionId: `provider-session:${taskId}`, providerRequestId: "request", inputTokens: tokens, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: tokens, costAmount: 0, costCurrency: "USD", costSource: "provider_reported" })] });
  store.reportTaskUsageSnapshot(parent.id, snapshot(parent.id, "v2-parent", 12));
  store.failTask(parent.id, { error: "synthetic retry", failureReason: "runtime_recovery" });
  const retry = store.listTasks().find(task => task.parentTaskId === parent.id)!;
  expect(retry.id).not.toBe(parent.id);
  expect(retry).toMatchObject({ attempt: 2, parentTaskId: parent.id, status: "queued" });
  if (startupWhileQueued) {
    ensureUsageAccountingStartup(db);
    expect(db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(retry.id)).toEqual([]);
  }
  expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  store.startTask(retry.id, "v2-retry", runtime.id);
  store.reportTaskUsageSnapshot(retry.id, snapshot(retry.id, "v2-retry", 5));
  store.completeTask(retry.id, { output: "synthetic complete" });
  const before = store.getUsageReport({ workspaceId: "local", days: null, runtimeId: runtime.id }).summary;
  expect(before).toMatchObject({ actual_total_tokens: 17, unknown_task_count: 0, complete: true });
  ensureUsageAccountingStartup(db);
  ensureUsageAccountingStartup(db);
  expect(db.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(retry.id)).toEqual([{ run_id: "v2-retry" }]);
  expect(store.getUsageReport({ workspaceId: "local", days: null, runtimeId: runtime.id }).summary).toEqual(before);
  const perTask = db.query(`SELECT task_id,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS actual
    FROM multiremi_usage_units WHERE task_id IN (?,?) GROUP BY task_id ORDER BY task_id`).all(parent.id, retry.id) as { task_id: string; actual: number | string }[];
  expect(perTask.map(row => [row.task_id, Number(row.actual)])).toEqual([[parent.id, 12], [retry.id, 5]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function assertNonconsumingHistoryBoundary(store: MultiremiStore, db: SqlDatabase, taskId: string,
  kind: "empty_modern" | "empty_history" | "context_history"): void {
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status='completed',completed_at='2026-10-01T01:00:00Z',usage=? WHERE id=?",
    [JSON.stringify([{ provider: "claude", totalTokens: 70 }]), taskId]);
  migrateLegacyUsage(db);
  store.reportTaskUsageSnapshot(taskId, { version: 2, runId: kind === "empty_modern" ? "start-only" : "historical-evidence-v2", revision: 1, complete: false,
    units: kind === "context_history" ? [{ ...actualUnit({ unitId: "context", provider: "claude", scope: "turn", source: "context_snapshot", accuracy: "unknown" }),
      contextTokens: 80000 }] : [] });
  // First test source refresh, then a deprecated report update at a higher floor.
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [JSON.stringify([{ provider: "claude", inputTokens: 20, outputTokens: 0 }]), taskId]);
  expect(migrateLegacyUsage(db).complete).toBe(true);
  expect(hasPendingLegacyUsage(db)).toBe(false);
  store.reportTaskUsage(taskId, [{ provider: "claude", model: "unknown", inputTokens: 30, outputTokens: 0 }]);
  migrateLegacyUsage(db);
  expect(Number(db.query(`SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)) AS n
    FROM multiremi_usage_units WHERE task_id=?`).get(taskId).n)).toBe(30);
  if (kind === "context_history") expect(Number(db.query("SELECT context_tokens FROM multiremi_usage_units WHERE task_id=? AND unit_id='context'").get(taskId).context_tokens)).toBe(80000);
}
