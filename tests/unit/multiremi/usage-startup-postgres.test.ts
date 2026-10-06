import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { actualUnit } from "@acp/usage-collector.js";
import { migrateLegacyUsage, USAGE_CUTOVER_MARKER, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { prepareUsageAccountingStartup, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-migration.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `multiremi_usage_startup_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let admin: Bun.SQL | undefined;
let db: PostgresSyncDatabase | undefined;
let isolatedUrl = "";
let store: MultiremiStore;
let databaseCreated = false;

describe.skipIf(!adminUrl)("usage startup on isolated PostgreSQL", () => {
  beforeAll(async () => {
    if (!adminUrl || !/^multiremi_usage_startup_\d+_\d+$/.test(databaseName)) throw new Error("Invalid isolated database name");
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    const url = new URL(adminUrl); url.pathname = `/${databaseName}`; isolatedUrl = url.toString();
    db = new PostgresSyncDatabase(isolatedUrl);
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await prepareUsageAccountingStartup(db);
  }, 30_000);

  beforeEach(() => {
    // The shared SQL adapter does not enforce foreign-key cascades. Reset both
    // migration checkpoints and normalized facts before deleting their tasks.
    for (const table of [
      "multiremi_usage_cost_coverage", "multiremi_usage_units", "multiremi_usage_run_scopes", "multiremi_usage_runs", "multiremi_usage_task_scopes",
      "multiremi_usage_legacy_versions", "multiremi_usage_legacy_sources", "multiremi_usage_legacy_audit",
    ]) db!.run(`DELETE FROM ${table}`);
    db!.run("DELETE FROM multiremi_turn_attempts");
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id IN (?,?)", [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]);
    db!.run("DELETE FROM multiremi_usage_startup_progress");
  });

  afterAll(async () => {
    db?.close();
    if (admin && databaseCreated) {
      await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    }
    if (admin) await admin.end({ timeout: 1 });
  });

  function tasks(count: number) {
    const agent = store.createAgent({ name: "scalar-startup-pg", provider: "codex", workspaceId: "local" });
    return Array.from({ length: count }, () => {
      const task = store.createTask({ agentId: agent.id, prompt: "isolated scalar migration", workspaceId: "local" });
      runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET usage=?,updated_at=? WHERE id=?", [JSON.stringify([{ provider: "codex", inputTokens: 11, outputTokens: 2, totalTokens: 4000 }]), "2026-10-01T00:00:00Z", task.id]);
      return task;
    });
  }
  function checkpointCount() { return Number((db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_sources").get() as { n: string }).n); }
  function ready() { return db!.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER); }

  it("makes a fresh database ready", async () => {
    await prepareUsageAccountingStartup(db!);
    expect(ready()).not.toBeNull();
    expect(checkpointCount()).toBe(0);
  });

  it("resumes committed checkpoints after a startup interruption", async () => {
    tasks(3);
    await expect(prepareUsageAccountingStartup(db!, { batchSize: 1, onBatch() { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(checkpointCount()).toBe(1);
    expect(ready()).toBeNull();
    await prepareUsageAccountingStartup(db!, { batchSize: 1 });
    expect(checkpointCount()).toBe(3);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(39);
  });

  it("rechecks source changes after a prepared migration", async () => {
    const [task] = tasks(1);
    migrateLegacyUsage(db!);
    expect(ready()).toBeNull();
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [JSON.stringify([{ provider: "codex", inputTokens: 30, outputTokens: 4 }]), task!.id]);
    await prepareUsageAccountingStartup(db!);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(34);
    expect(Number((db!.query("SELECT source_version FROM multiremi_usage_legacy_sources WHERE task_id=?").get(task!.id) as { source_version: number }).source_version)).toBe(2);
    expect(Number((db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_versions").get() as { n: string }).n)).toBe(3);
  });

  it("rechecks ready startup after a legacy rollback without creating empty runs for v2 tasks", async () => {
    const task = tasks(1)[0]!;
    await prepareUsageAccountingStartup(db!);
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [JSON.stringify([{ provider: "codex", inputTokens: 30, outputTokens: 4 }]), task.id]);
    await prepareUsageAccountingStartup(db!);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(34);
    for (const source of ["[]"]) {
      const next = store.createTask({ agentId: task.agentId, prompt: "v2-only startup", workspaceId: "local" });
      runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET usage=? WHERE id=?", [source, next.id]);
      writeUsageSnapshot(db!, next.id, { version: 2, runId: "v2-only", revision: 1, complete: true,
        units: [actualUnit({ unitId: "request", provider: "codex", scope: "request", source: "provider_request", inputTokens: 5, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 })] });
      await prepareUsageAccountingStartup(db!);
      runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',completed_at='2026-10-03T00:00:00Z' WHERE id=?", [next.id]);
      await prepareUsageAccountingStartup(db!);
      expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(next.id)).toEqual([{ run_id: "v2-only" }]);
      expect(db!.query("SELECT task_id FROM multiremi_usage_legacy_sources WHERE task_id=?").get(next.id)).toBeNull();
    }
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(39);
  });

  it("does not invent legacy consumption for a queued first attempt across startup on PostgreSQL", async () => {
    const agent = store.createAgent({ name: "queued restart pg", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "queued", workspaceId: "local" });
    await prepareUsageAccountingStartup(db!);
    await prepareUsageAccountingStartup(db!);
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(task.id)).toEqual([]);
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T01:00:00Z' WHERE id=?", [task.id]);
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "first-v2", revision: 1, complete: true,
      units: [actualUnit({ unitId: "request", provider: "codex", scope: "request", source: "provider_request", inputTokens: 5, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costAmount: 0, costCurrency: "USD", costSource: "provider_reported" })] });
    await prepareUsageAccountingStartup(db!);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 5, unknown_task_count: 0, complete: true });
  });

  it("keeps missing prior-attempt usage when complete modern retry facts precede startup on PostgreSQL", async () => {
    const agent = store.createAgent({ name: "retry before cutover pg", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "old attempt unknown", workspaceId: "local" });
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET attempt=2,status='completed',completed_at='2026-10-01T01:00:00Z' WHERE id=?", [task.id]);
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "modern-retry", revision: 1, complete: true,
      units: [actualUnit({ unitId: "request", provider: "codex", scope: "request", source: "provider_request", inputTokens: 5, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costAmount: 0, costCurrency: "USD", costSource: "provider_reported" })] });
    await prepareUsageAccountingStartup(db!);
    await prepareUsageAccountingStartup(db!);
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? ORDER BY run_id").all(task.id)).toEqual([{ run_id: "legacy" }, { run_id: "modern-retry" }]);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 5, unknown_task_count: 1, complete: false });
  });

  it("serializes two real UI/runtime startup processes without duplicate source versions", async () => {
    tasks(8);
    const childCode = `
      import { PostgresSyncDatabase } from './packages/server/src/store/db/postgres.ts';
      import { MultiremiStore } from './packages/server/src/store/store.ts';
      import { prepareUsageAccountingStartup } from './packages/server/src/store/usage-migration.ts';
      const db = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL);
      try {
        new MultiremiStore(db);
        await prepareUsageAccountingStartup(db, { batchSize: 1 });
        process.stdout.write('ready');
      } catch (error) { process.stderr.write(error.name + ': ' + error.message); process.exitCode = 1; }
      finally { db.close(); }
    `;
    const children = ["ui", "runtime"].map(role => Bun.spawn([process.execPath, "-e", childCode], {
      cwd: process.cwd(), env: { ...process.env, MULTIREMI_TEST_POSTGRES_URL: isolatedUrl, MULTIREMI_API_ROLE: role }, stdout: "pipe", stderr: "pipe",
    }));
    const results = await Promise.all(children.map(async child => ({
      code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(),
    })));
    for (const result of results) { expect(result.err).toBe(""); expect(result.code).toBe(0); expect(result.out).toBe("ready"); }
    expect(ready()).not.toBeNull();
    expect(checkpointCount()).toBe(8);
    expect(Number((db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_versions").get() as { n: string }).n)).toBe(16);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(104);
  }, 30_000);

  it("preserves a modern snapshot committed on another connection after a legacy checkpoint", async () => {
    const cohort = tasks(2).sort((a, b) => a.id.localeCompare(b.id));
    const writer = new PostgresSyncDatabase(isolatedUrl);
    let arrived = false;
    try {
      await prepareUsageAccountingStartup(db!, { batchSize: 1, onBatch() {
        if (arrived) return;
        arrived = true;
        writeUsageSnapshot(writer, cohort[0]!.id, { version: 2, runId: "modern-arrival", revision: 1, complete: true, units: [{
          unitId: "request", revision: 1, provider: "codex", model: "actual", modelSource: "provider_reported", scope: "request", source: "provider_request", accuracy: "exact",
          inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 5,
          contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T01:00:00Z",
        }] });
      } });
      expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? ORDER BY run_id").all(cohort[0]!.id)).toEqual([{ run_id: "legacy" }, { run_id: "modern-arrival" }]);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(31);
    } finally { writer.close(); }
  });

  it("keeps known legacy consumption when another connection accepts an empty modern run", async () => {
    const task = tasks(1)[0]!;
    migrateLegacyUsage(db!);
    const writer = new PostgresSyncDatabase(isolatedUrl);
    try {
      writeUsageSnapshot(writer, task.id, { version: 2, runId: "empty-accepted-start", revision: 0, complete: false, units: [] });
      await prepareUsageAccountingStartup(db!);
      expect(store.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 13, unknown_task_count: 1, complete: false });
      expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=? ORDER BY run_id").all(task.id)).toEqual([{ run_id: "empty-accepted-start" }, { run_id: "legacy" }]);
    } finally { writer.close(); }
  });
});
