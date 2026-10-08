import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

function assertSupersededReceipts(db: SqlDatabase, reconnect: () => { db: SqlDatabase; store: MultiremiStore }) {
  let store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ name: "superseded", provider: "claude", workspaceId: "local" });
  const otherRuntime = store.registerRuntime({ name: "unauthorized", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "superseded", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "retired observations", workspaceId: "local" });
  store.claimTask(runtime.id); store.startTask(task.id);
  const authority = { runtimeId: runtime.id, workspaceId: "local", daemonId: "test-daemon" };
  const base: TaskUsageUnit = { unitId: "live", revision: 1, provider: "claude", model: "opus", scope: "request",
    source: "provider_request", accuracy: "exact", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0,
    cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12, contextTokens: null, contextWindow: null,
    costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00Z" };
  const retired = [
    { ...base, unitId: "old-unsplit", revision: 2, scope: "turn" as const, source: "provider_turn" as const,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: 20, reportedTotalTokens: 20, accuracy: "unknown" as const },
    { ...base, unitId: "old-codex-meter", revision: 2, provider: "codex", accuracy: "unknown" as const,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: null, reportedTotalTokens: 100, evidenceRef: "codex_meter_epoch_unresolved" },
  ];
  const write = (units: TaskUsageUnit[], revision: number, auth = authority) => store.reportTaskUsageSnapshot(task.id,
    { version: 2, runId: "existing-run", revision, complete: true, units }, auth);
  write([base, ...retired], 2);
  // The reviewed repair retires canonical rows and persists receipts atomically.
  // Full native-evidence repair planning is covered by its own integration suite.
  db.transaction(() => {
    for (const unit of retired) {
      db.run("UPDATE multiremi_usage_unit_receipts SET revision=3,disposition='superseded' WHERE task_id=? AND run_id=? AND unit_id=?", [task.id, "existing-run", unit.unitId]);
      db.run("DELETE FROM multiremi_usage_units WHERE task_id=? AND run_id=? AND unit_id=?", [task.id, "existing-run", unit.unitId]);
    }
  })();
  const total = () => store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens;
  const assertRetired = () => {
    expect(total()).toBe(12);
    expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id=? AND unit_id IN ('old-unsplit','old-codex-meter')").get(task.id) as { n: number }).n)).toBe(0);
    expect(db.query("SELECT revision,disposition FROM multiremi_usage_unit_receipts WHERE task_id=? AND unit_id IN ('old-unsplit','old-codex-meter') ORDER BY unit_id").all(task.id)).toEqual([
      { revision: 3, disposition: "superseded" }, { revision: 3, disposition: "superseded" },
    ]);
  };
  for (const revision of [1, 3, 100]) { write(retired.map(unit => ({ ...unit, revision })), revision); assertRetired(); }
  const reopened = reconnect(); db = reopened.db; store = reopened.store;
  for (const revision of [1, 3, 101]) { write(retired.map(unit => ({ ...unit, revision })), revision); assertRetired(); }
  const finalRun = db.query("SELECT revision,complete FROM multiremi_usage_runs WHERE task_id=? AND run_id='existing-run'").get(task.id);
  store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "existing-run", revision: 102, complete: false,
    units: retired.map(unit => ({ ...unit, revision: 102 })) }, authority);
  expect(db.query("SELECT revision,complete FROM multiremi_usage_runs WHERE task_id=? AND run_id='existing-run'").get(task.id)).toEqual(finalRun);
  assertRetired();
  expect(() => write(retired.map(unit => ({ ...unit, revision: 102 })), 102, { ...authority, runtimeId: otherRuntime.id })).toThrow("authority_revoked");
  expect(() => write(retired.map(unit => ({ ...unit, revision: 102 })), 102, { ...authority, workspaceId: "other-workspace" })).toThrow("authority_revoked");
  assertRetired();
  write([{ ...base, revision: 2, inputTokens: 20, reportedTotalTokens: 22 },
    { ...base, unitId: "new-request", providerSessionId: "new-native-session", providerRequestId: "new-native-request" }], 103);
  expect(total()).toBe(34);
  expect(db.query("SELECT revision,disposition FROM multiremi_usage_unit_receipts WHERE task_id=? AND unit_id='live'").get(task.id)).toEqual({ revision: 2, disposition: "accepted" });
}

it("keeps superseded receipts durable without suppressing authorized new usage on SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-superseded-"));
  const filename = join(directory, "ledger.sqlite");
  let db = openSqliteDatabase(filename);
  try {
    assertSupersededReceipts(db, () => {
      db.close(); db = openSqliteDatabase(filename);
      return { db, store: new MultiremiStore(db) };
    });
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

it.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("keeps superseded receipts durable without suppressing authorized new usage on PostgreSQL", async () => {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL!;
  const databaseName = `usage_superseded_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  if (!/^usage_superseded_\d+_\d+$/.test(databaseName)) throw new Error("Invalid isolated database name");
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  let db: PostgresSyncDatabase | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`); created = true;
    const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
    db = new PostgresSyncDatabase(url.toString());
    assertSupersededReceipts(db, () => {
      db!.close(); db = new PostgresSyncDatabase(url.toString());
      return { db, store: new MultiremiStore(db) };
    });
  } finally {
    db?.close();
    if (created) await admin.unsafe(`DROP DATABASE ${databaseName}`);
    await admin.end();
  }
}, 30_000);
