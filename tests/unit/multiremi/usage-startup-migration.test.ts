import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMultiremiServer } from "@multiremi/api/server.js";
import { legacyUsageSnapshot, migrateLegacyUsage, USAGE_CUTOVER_MARKER, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { ensureUsageAccountingStartup, prepareUsageAccountingStartup, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-migration.js";
import type { TaskUsageSnapshot } from "@multiremi/contracts/usage-accounting.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const firstUsage = JSON.stringify([{ provider: "claude", model: "configured", totalTokens: 999, inputTokens: 100, outputTokens: 2 }]);
function fixture(count = 1) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "startup-migration", provider: "claude", workspaceId: "local" });
  const tasks = Array.from({ length: count }, () => store.createTask({ agentId: agent.id, prompt: "scalar migration", workspaceId: "local" })).sort((a, b) => a.id.localeCompare(b.id));
  db!.run("DELETE FROM multiremi_schema_migrations WHERE id IN (?,?)", [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]);
  for (const task of tasks) db!.run("UPDATE multiremi_tasks SET usage=?,updated_at=? WHERE id=?", [firstUsage, "2026-10-01T00:00:00.000Z", task.id]);
  return { store, tasks };
}
function marker() { return db!.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER); }
const live = (runId: string): TaskUsageSnapshot => ({ version: 2, runId, revision: 1, complete: true, units: [{
  unitId: "verified", revision: 1, provider: "claude", model: "actual", modelSource: "provider_reported", source: "provider_request", scope: "request", accuracy: "exact",
  inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 5,
  contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T01:00:00.000Z",
}] });

describe("automatic scalar usage cutover", () => {
  it("starts a fresh database and serves canonical empty reports", async () => {
    const store = createLocalStore();
    await prepareUsageAccountingStartup(db!);
    expect(marker()).not.toBeNull();
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(0);
  });

  it("migrates existing scalars without making consumption from a context-like legacy total", async () => {
    const { store, tasks } = fixture(2);
    db!.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [JSON.stringify([{ provider: "codex", totalTokens: 9000, inputTokens: 0, outputTokens: 0 }]), tasks[1]!.id]);
    await prepareUsageAccountingStartup(db!, { batchSize: 1 });
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(102);
    expect(db!.query("SELECT input_tokens,output_tokens,actual_unsplit_tokens,reported_total_tokens,context_tokens FROM multiremi_usage_units WHERE task_id=?").get(tasks[1]!.id)).toEqual({
      input_tokens: null, output_tokens: null, actual_unsplit_tokens: null, reported_total_tokens: 9000, context_tokens: null,
    });
    expect(db!.query("SELECT original_usage FROM multiremi_usage_legacy_audit WHERE task_id=?").get(tasks[0]!.id)).toEqual({ original_usage: firstUsage });
  });

  it("resumes task checkpoints after an interrupted batch without overwriting original audit values", async () => {
    const { tasks } = fixture(3);
    await expect(prepareUsageAccountingStartup(db!, { batchSize: 1, onBatch: () => { throw new Error("simulated process interruption"); } })).rejects.toThrow("simulated process interruption");
    expect(marker()).toBeNull();
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_sources").get()).toEqual({ n: 1 });
    const originalQuery = db!.query.bind(db!);
    const resumed = new Proxy(db!, { get(target, key) {
      if (key === "query") return (sql: string) => {
        const statement = originalQuery(sql);
        if (!sql.includes("SELECT t.id,t.usage,")) return statement;
        return new Proxy(statement, { get(source, field) {
          if (field === "get") return (...args: Parameters<typeof source.get>) => {
            if (args[0] === tasks[0]!.id) throw new Error("Restart reread a task before its durable cursor");
            return source.get(...args);
          };
          const value = Reflect.get(source, field); return typeof value === "function" ? value.bind(source) : value;
        } });
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await prepareUsageAccountingStartup(resumed, { batchSize: 1 });
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_sources WHERE source_version=1").get()).toEqual({ n: 3 });
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_versions").get()).toEqual({ n: 6 });
    expect(marker()).not.toBeNull();
  });

  it("detects old-server writes after preparation, replaces removed entries and retains source versions", async () => {
    const { store, tasks } = fixture();
    expect(migrateLegacyUsage(db!).complete).toBe(true);
    expect(marker()).toBeNull();
    const updated = JSON.stringify([{ provider: "claude", totalTokens: 1234, inputTokens: 200, outputTokens: 4 }]);
    db!.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [updated, tasks[0]!.id]);
    await prepareUsageAccountingStartup(db!);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(204);
    expect(db!.query("SELECT original_usage FROM multiremi_usage_legacy_audit").get()).toEqual({ original_usage: firstUsage });
    expect(db!.query("SELECT source_version,original_usage FROM multiremi_usage_legacy_versions ORDER BY source_version").all()).toEqual([
      { source_version: 0, original_usage: firstUsage }, { source_version: 1, original_usage: firstUsage }, { source_version: 2, original_usage: updated },
    ]);
  });

  it("upgrades checkpoints from the original preparation implementation", async () => {
    const { tasks } = fixture();
    db!.run("INSERT INTO multiremi_usage_legacy_audit(task_id,original_usage,migrated_at) VALUES(?,?,?)", [tasks[0]!.id, firstUsage, "2026-10-01T00:00:00Z"]);
    db!.run("UPDATE multiremi_tasks SET usage='[]' WHERE id=?", [tasks[0]!.id]);
    await prepareUsageAccountingStartup(db!);
    expect(db!.query("SELECT original_usage FROM multiremi_usage_legacy_audit").get()).toEqual({ original_usage: firstUsage });
    expect(db!.query("SELECT original_usage FROM multiremi_usage_legacy_versions ORDER BY source_version").all()).toEqual([{ original_usage: firstUsage }, { original_usage: "[]" }]);
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_units").get()).toEqual({ n: 0 });
  });

  it("retires an original revision-zero preparation aggregate when modern facts already exist", async () => {
    const { store, tasks } = fixture();
    writeUsageSnapshot(db!, tasks[0]!.id, legacyUsageSnapshot(tasks[0]!.id, firstUsage, "2026-10-01T00:00:00Z"), { historical: true });
    db!.run("INSERT INTO multiremi_usage_legacy_audit(task_id,original_usage,migrated_at) VALUES(?,?,?)", [tasks[0]!.id, firstUsage, "2026-10-01T00:00:00Z"]);
    writeUsageSnapshot(db!, tasks[0]!.id, live("modern-existing"));
    await prepareUsageAccountingStartup(db!);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(5);
    expect(db!.query("SELECT original_usage FROM multiremi_usage_legacy_audit").get()).toEqual({ original_usage: firstUsage });
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs").all()).toEqual([{ run_id: "modern-existing" }]);
  });

  it("rechecks changed rows behind the cursor and preserves modern snapshots arriving between batches", async () => {
    const { store, tasks } = fixture(2);
    let changed = false;
    await prepareUsageAccountingStartup(db!, { batchSize: 1, onBatch: () => {
      if (changed) return;
      changed = true;
      db!.run("UPDATE multiremi_tasks SET usage='[]' WHERE id=?", [tasks[0]!.id]);
      writeUsageSnapshot(db!, tasks[1]!.id, live("modern"));
    } });
    expect(db!.query("SELECT source_version FROM multiremi_usage_legacy_sources WHERE task_id=?").get(tasks[0]!.id)).toEqual({ source_version: 2 });
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(tasks[1]!.id)).toEqual([{ run_id: "modern" }]);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(5);
  });

  it("never replaces evidence-verified recovered facts with changed legacy JSON", async () => {
    const { tasks } = fixture();
    migrateLegacyUsage(db!);
    writeUsageSnapshot(db!, tasks[0]!.id, live("historical-evidence-v2"), { historical: true });
    const before = db!.query("SELECT * FROM multiremi_usage_units ORDER BY run_id").all();
    db!.run("UPDATE multiremi_tasks SET usage='[]' WHERE id=?", [tasks[0]!.id]);
    await prepareUsageAccountingStartup(db!);
    expect(db!.query("SELECT * FROM multiremi_usage_units ORDER BY run_id").all()).toEqual(before);
  });

  it("rechecks a source changed after the final batch and before the readiness marker", async () => {
    const { store, tasks } = fixture();
    const originalQuery = db!.query.bind(db!);
    let changed = false;
    const cutover = new Proxy(db!, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (!changed && sql.includes("s.task_id IS NULL") && sql.endsWith("LIMIT 1")) {
          changed = true;
          db!.run("UPDATE multiremi_tasks SET usage=? WHERE id=?", [JSON.stringify([{ provider: "claude", inputTokens: 250 }]), tasks[0]!.id]);
        }
        return originalQuery(sql);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await prepareUsageAccountingStartup(cutover);
    expect(changed).toBe(true);
    expect(marker()).not.toBeNull();
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(250);
  });

  it("retires its provisional aggregate when a modern snapshot arrives after a task checkpoint", async () => {
    const { store, tasks } = fixture(2);
    let arrived = false;
    await prepareUsageAccountingStartup(db!, { batchSize: 1, onBatch: () => {
      if (arrived) return;
      arrived = true;
      writeUsageSnapshot(db!, tasks[0]!.id, live("modern-after-checkpoint"));
    } });
    expect(db!.query("SELECT run_id FROM multiremi_usage_runs WHERE task_id=?").all(tasks[0]!.id)).toEqual([{ run_id: "modern-after-checkpoint" }]);
    expect(store.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(107);
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_legacy_versions WHERE task_id=?").get(tasks[0]!.id)).toEqual({ n: 2 });
  });

  it("unchanged ready startup reads only its marker", async () => {
    fixture();
    await prepareUsageAccountingStartup(db!);
    const originalQuery = db!.query.bind(db!);
    const proxy = new Proxy(db!, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (!sql.includes("multiremi_schema_migrations")) throw new Error("Ready startup scanned history");
        return originalQuery(sql);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await prepareUsageAccountingStartup(proxy);
    ensureUsageAccountingStartup(proxy);
  });

  it("a failed scalar transaction cannot establish readiness and retries cleanly", async () => {
    fixture();
    db!.exec("CREATE TRIGGER reject_usage_version BEFORE INSERT ON multiremi_usage_legacy_audit BEGIN SELECT RAISE(ABORT,'migration failed'); END");
    await expect(prepareUsageAccountingStartup(db!)).rejects.toThrow("migration failed");
    expect(marker()).toBeNull();
    expect(db!.query("SELECT count(*) AS n FROM multiremi_usage_units").get()).toEqual({ n: 0 });
    db!.exec("DROP TRIGGER reject_usage_version");
    await prepareUsageAccountingStartup(db!);
    expect(marker()).not.toBeNull();
  });

  it("refuses the HTTP listener and background jobs on startup migration failure", () => {
    const { store } = fixture();
    db!.exec("CREATE TRIGGER reject_usage_startup BEFORE INSERT ON multiremi_usage_legacy_audit BEGIN SELECT RAISE(ABORT,'startup failed'); END");
    let started = false;
    expect(() => startMultiremiServer({ store, port: 0, backgroundJobs: true, scheduler: { start() { started = true; } } as any })).toThrow("startup failed");
    expect(started).toBe(false);
    expect(marker()).toBeNull();
  });

  it("bounds startup duration and resumes after a timeout", async () => {
    fixture(2);
    await expect(prepareUsageAccountingStartup(db!, { batchSize: 1, timeoutMs: 1, onBatch: () => Bun.sleepSync(2) })).rejects.toThrow("timed out");
    expect(marker()).toBeNull();
    await prepareUsageAccountingStartup(db!, { batchSize: 1 });
    expect(marker()).not.toBeNull();
  });

  it("runs two real startup migration processes against one isolated SQLite file", async () => {
    fixture(6);
    const root = mkdtempSync(join(tmpdir(), "usage-startup-concurrent-"));
    const databasePath = join(root, "startup.sqlite");
    writeFileSync(databasePath, db!.serialize());
    const code = `
      import { openSqliteDatabase } from './packages/server/src/store/db/sqlite.ts';
      import { prepareUsageAccountingStartup } from './packages/server/src/store/usage-migration.ts';
      const db = openSqliteDatabase(process.env.MULTIREMI_TEST_USAGE_DB);
      db.exec('PRAGMA busy_timeout=10000');
      try { await prepareUsageAccountingStartup(db, { batchSize: 1 }); process.stdout.write('ready'); }
      catch(error) { process.stderr.write(error.message); process.exitCode=1; }
      finally { db.close(); }
    `;
    const children = [1, 2].map(() => Bun.spawn([process.execPath, "-e", code], {
      cwd: process.cwd(), env: { ...process.env, MULTIREMI_TEST_USAGE_DB: databasePath }, stdout: "pipe", stderr: "pipe",
    }));
    try {
      const results = await Promise.all(children.map(async child => ({ code: await child.exited,
        out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));
      for (const result of results) { expect(result.err).toBe(""); expect(result.code).toBe(0); expect(result.out).toBe("ready"); }
      const { openSqliteDatabase } = await import("@multiremi/store/db/sqlite.js");
      const shared = openSqliteDatabase(databasePath);
      try {
        expect(shared.query("SELECT count(*) AS n FROM multiremi_usage_legacy_sources WHERE source_version=1").get()).toEqual({ n: 6 });
        expect(shared.query("SELECT count(*) AS n FROM multiremi_usage_legacy_versions").get()).toEqual({ n: 12 });
        expect(shared.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER)).not.toBeNull();
      } finally { shared.close(); }
    } finally {
      for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
