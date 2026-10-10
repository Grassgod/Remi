import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rehearseUnifiedModelCopy, validateCopyDatabaseUrl } from "../../../scripts/rehearse-unified-model-copy.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { ensureUsageAccountingSchema, writeUsageSnapshot, USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER } from "@multiremi/store/usage-accounting.js";
import { collectCopyUsageSnapshot, reconcileCopyUsage } from "../../../scripts/unified-model-copy-usage.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { runCopyStartupProcess, validateCopyBuild, type CopyStartupInput } from "../../../scripts/unified-model-copy-startup.js";

async function prepareHistoricalUsage(db: SqlDatabase): Promise<SqlDatabase> {
  const rewrite = (sql: string) => sql.replaceAll("multiremi_turn_execution_records", "multiremi_tasks")
    .replaceAll("multiremi_turn_attempts", "multiremi_tasks").replaceAll("multiremi_turns", "multiremi_tasks")
    .replaceAll("ar.turn_id=t.turn_id", "ar.task_id=t.id");
  const historical = new Proxy(db, { get(target, key) {
    if (key === "exec") return (sql: string) => target.exec(rewrite(sql));
    if (key === "query") return (sql: string) => target.query(rewrite(sql));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  for (const marker of [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]) {
    db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [marker, new Date().toISOString()]);
  }
  ensureUsageAccountingSchema(historical);
  for (const task of db.query("SELECT id,created_at FROM multiremi_tasks").all() as { id: string; created_at: string }[]) {
    writeUsageSnapshot(historical, task.id, { version: 2, runId: "legacy", revision: 1, complete: false, units: [{
      unitId: "historical", revision: 1, provider: "codex", model: null, modelSource: "unknown",
      scope: "task", source: "legacy_task", accuracy: "unknown", inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null,
      contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: task.created_at,
    }] }, { historical: true });
  }
  return historical;
}

const dirs: string[] = [];
const output = () => { const dir = mkdtempSync(join(tmpdir(), "mul493-copy-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("rehearsal refuses production, local, alternate-role and query-overridden targets before connecting", () => {
  const copy = "postgresql://mul493_rehearsal@mul493-copy-postgres:5432/mul493_rehearsal";
  expect(validateCopyDatabaseUrl(copy)).toBe(copy);
  for (const value of [undefined, "invalid", copy.replace("mul493-copy-postgres", "n37-117-209.byted.org"),
    copy.replace("mul493-copy-postgres", "127.0.0.1"), copy.replace("@", ":secret@"),
    copy.replace("5432", "5433"), copy.replace("/mul493_rehearsal", "/multiremi"),
    copy.replace("mul493_rehearsal@", "postgres@"), `${copy}?host=production`, `${copy}#fragment`]) {
    expect(() => validateCopyDatabaseUrl(value)).toThrow();
  }
});

unifiedModelBackendTests("MUL-493 offline copy rehearsal", fixture => {
  test("keeps retry identities, usage checkpoints and partial real read progress across both role startups and restarts", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "copy worker", provider: "codex" });
    const issue = store.createIssue({ title: "copy", assigneeType: "member", assigneeId: "mem_local_local" });
    db.run("UPDATE multiremi_issues SET status='backlog' WHERE id=?", [issue.id]);
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "first" });
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", parentTaskId: first.id, attempt: 2 });
    db.run("UPDATE multiremi_tasks SET status='failed' WHERE id=?", [first.id]);
    db.run("UPDATE multiremi_tasks SET status='completed' WHERE id=?", [second.id]);
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db.run(`INSERT INTO multiremi_issue_decisions(id,workspace_id,issue_id,source_issue_id,kind,title,body,options,
      status,created_by_agent_id,created_at,updated_at)
      VALUES('dec_copy','local',?,?,'question','Choose','copy decision','[]','pending',?,?,?)`,
      [issue.id, issue.id, agent.id, first.createdAt, first.createdAt]);
    db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq=2,parent_cursor_seq=1,provider_session_id='checkpoint',work_dir='/copy/work',generation=3 WHERE session_id=? AND agent_id=?", [session.id, agent.id]);
    db.run("UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?", [JSON.stringify({ [agent.id]: { seq: 1, offset: 17 } }), session.id]);
    const historical = await prepareHistoricalUsage(db);
    writeUsageSnapshot(historical, second.id, { version: 2, runId: "existing", revision: 1, complete: true, units: [{
      unitId: "actual", revision: 1, provider: "codex", model: "observed", modelSource: "provider_reported",
      scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 8, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 10,
      contextTokens: null, contextWindow: null, costAmount: 0.01, costCurrency: "USD", costSource: "provider_reported",
      providerSessionId: "history-session", providerRequestId: "request-1", occurredAt: first.createdAt,
    }, {
      unitId: "context", revision: 1, provider: "codex", model: null, modelSource: "unknown",
      scope: "turn", source: "context_snapshot", accuracy: "unknown", inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null,
      contextTokens: 78048, contextWindow: 200000, costAmount: null, costCurrency: null, occurredAt: first.createdAt,
    }] }, { historical: true });
    const dir = output();
    const result = await rehearseUnifiedModelCopy(db, dir);
    expect(result.mismatches).toEqual([]);
    expect(result.counts.attempts).toBe(2);
    expect(result.counts.turns).toBe(1);
    expect(result.partial_read_count).toBe(1);
    expect(result.counts.decisions).toBe(1);
    expect(db.query("SELECT l.cursor_seq,h.head_seq FROM multiremi_session_lanes l JOIN multiremi_conversation_heads h ON h.session_id=l.session_id WHERE l.reader_type='member'").all()
      .every((row: any) => row.cursor_seq === row.head_seq)).toBe(true);
    expect(result.issue_sampling).toBe("manual review required");
    expect(db.query("SELECT cursor_seq,cursor_offset,provider_cursor_seq,parent_cursor_seq,provider_session_id FROM multiremi_session_lanes WHERE reader_type='agent' AND reader_id=?").get(agent.id))
      .toEqual({ cursor_seq: 1, cursor_offset: 17, provider_cursor_seq: 2, parent_cursor_seq: 1, provider_session_id: "checkpoint" });
    const report = JSON.parse(readFileSync(join(dir, "copy-reconciliation.json"), "utf8"));
    expect(report.issue_samples[0].turns[0].attempts).toBe(2);
    expect(report.issue_samples[0].status).toBe("backlog");
    expect(result.migrationMs).toBeGreaterThan(0);
    expect(result.restartMs).toBeGreaterThan(0);
    expect(result.startup.map((s: any) => [s.phase, s.role])).toEqual([
      ["first_start", "api"], ["first_start", "api-runtime"], ["restart", "api"], ["restart", "api-runtime"],
    ]);
    expect(result.startup.every((s: any) => s.completed && s.steps_ms.run_migrations > 0)).toBe(true);
    expect(result.http_ready_measured).toBe(false);
    const usage = JSON.parse(readFileSync(join(dir, "copy-usage-reconciliation.json"), "utf8"));
    expect(usage.snapshots.before.markers).toHaveLength(2);
    expect(usage.snapshots.before.tables.multiremi_usage_units.count).toBeGreaterThan(0);
    expect(usage.snapshots.before.tables.multiremi_usage_request_owners.count).toBe(1);
    expect(usage.snapshots.before.unit_evidence.some((u: any) => Number(u.actual_tokens) === 10 && Number(u.cost_amount) === 0.01)).toBe(true);
    const context = usage.snapshots.before.unit_evidence.find((u: any) => u.source === "context_snapshot");
    expect(Number(context.context_tokens)).toBe(78048);
    expect(Number(context.actual_tokens)).toBe(0);
    expect(Number(context.unknown_consumption_units)).toBe(1);
    expect(context.cost_amount).toBeNull();
    expect(Object.values(usage.stages).every((s: any) => s.mismatches.length === 0)).toBe(true);
    await expect(rehearseUnifiedModelCopy(db, output())).rejects.toThrow("already migrated");
  });

  test("refuses an undrained copy without changing its task or schema", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "blocked copy", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "running" });
    db.run("UPDATE multiremi_tasks SET status='running' WHERE id=?", [task.id]);
    const dir = output();
    await expect(rehearseUnifiedModelCopy(db, dir)).rejects.toThrow("Copy is not drained");
    expect(db.query("SELECT status FROM multiremi_tasks WHERE id=?").get(task.id)?.status).toBe("running");
    expect(() => db.query("SELECT * FROM multiremi_turn_attempts").all()).toThrow();
    expect(JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8")).find((c: any) => c.name === "undrained_tasks").count).toBe(1);
  });

  test("rejects unprepared usage and detects same-count body, attribution, marker and money drift", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "usage drift", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "history", status: "completed" });
    await expect(rehearseUnifiedModelCopy(db, output())).rejects.toThrow("both #384 usage cutover markers");
    await prepareHistoricalUsage(db);
    const longBody = "evidence-tail-".repeat(2500);
    db.run("UPDATE multiremi_usage_units SET evidence_ref=? WHERE task_id=?", [longBody, task.id]);
    const before = collectCopyUsageSnapshot(db, "multiremi_tasks");
    db.run("UPDATE multiremi_usage_units SET evidence_ref=? WHERE task_id=?", [longBody.slice(0, -1) + "X", task.id]);
    const after = collectCopyUsageSnapshot(db, "multiremi_tasks");
    expect(after.tables.multiremi_usage_units.count).toBe(before.tables.multiremi_usage_units.count);
    expect(reconcileCopyUsage(before, after).changed_tables).toEqual(["multiremi_usage_units"]);
    const altered = structuredClone(before);
    altered.tables.multiremi_usage_units.orphan_task_refs = 1;
    altered.markers = [];
    altered.unit_evidence = [{ actual_tokens: 999, cost_amount: 99 }];
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage attempt attribution missing: multiremi_usage_units");
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage cutover markers changed");
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage actual/context/unknown/money evidence changed");
  });

  test("keeps failed schema startup timing and stops before the next role or restart", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "gate failure", provider: "codex" });
    store.createTask({ agentId: agent.id, prompt: "history", status: "completed" });
    await prepareHistoricalUsage(db);
    const failing = new Proxy(db, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (sql.includes("SELECT id FROM multiremi_turn_attempts LIMIT 1")) {
          throw new Error("synthetic schema startup failure");
        }
        return target.query(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const dir = output();
    await expect(rehearseUnifiedModelCopy(failing, dir)).rejects.toThrow("synthetic schema startup failure");
    const report = JSON.parse(readFileSync(join(dir, "copy-startup.json"), "utf8"));
    expect(report.startup).toHaveLength(1);
    expect(report.startup[0]).toMatchObject({ role: "api", phase: "first_start", failed: true, completed: false });
    expect(report.startup[0].steps_ms.run_migrations).toBeGreaterThan(0);
    expect(report.startup[0].steps_ms.readback_validation).toBeUndefined();
    expect(report.http_ready_measured).toBe(false);
  });

  test("fails rehearsal on same-count usage content drift and retains per-stage mismatch evidence", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "startup drift", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "history", status: "completed" });
    await prepareHistoricalUsage(db);
    let snapshots = 0;
    const drifting = new Proxy(db, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if ((sql.includes("table_info(multiremi_usage_units)") || (sql.includes("information_schema.columns") && sql.includes("multiremi_usage_units"))) && ++snapshots === 3) {
          target.run("UPDATE multiremi_usage_units SET evidence_ref='unexpected content change' WHERE task_id=?", [task.id]);
        }
        return target.query(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const dir = output();
    await expect(rehearseUnifiedModelCopy(drifting, dir)).rejects.toThrow("Copy reconciliation failed");
    const usage = JSON.parse(readFileSync(join(dir, "copy-usage-reconciliation.json"), "utf8"));
    expect(usage.stages.after_schema.mismatches).toEqual([]);
    expect(usage.stages.first_start_api.changed_tables).toEqual(["multiremi_usage_units"]);
    expect(JSON.parse(readFileSync(join(dir, "copy-timing.json"), "utf8")).mismatches)
      .toContain("first_start_api: usage content changed: multiremi_usage_units");
  });
});

test("offline process timing requires a full SHA and pinned digest before spawning", () => {
  for (const [sha, digest] of [[undefined, undefined], ["dab54917", `sha256:${"a".repeat(64)}`],
    ["a".repeat(40), "candidate:latest"], ["a".repeat(40), `sha256:${"a".repeat(63)}`]]) {
    expect(() => validateCopyBuild(sha, digest)).toThrow("Full candidate source SHA");
  }
});

const childCommand = [process.execPath, "--no-env-file", join(import.meta.dir, "../../helpers/unified-model-copy-startup-child.ts")];
const build = { sourceSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` };

unifiedModelBackendTests("MUL-493 independent offline role processes", fixture => {
  async function processFixture(failure?: string) {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "offline process", provider: "codex" });
    const issue = store.createIssue({ title: "offline copy", assigneeType: "member", assigneeId: "mem_local_local" });
    db.run("UPDATE multiremi_issues SET status='backlog' WHERE id=?", [issue.id]);
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "history", status: "completed" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq=2,parent_cursor_seq=1,provider_session_id='offline-checkpoint',generation=3 WHERE session_id=? AND agent_id=?", [session.id, agent.id]);
    db.run("UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?", [JSON.stringify({ [agent.id]: { seq: 1, offset: 7 } }), session.id]);
    await prepareHistoricalUsage(db);
    const dir = output();
    let parentDb = db;
    let path: string;
    if (db.dialect === "postgres") {
      const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
      url.pathname = `/${db.query("SELECT current_database() AS name").get()!.name}`;
      path = url.toString();
    } else {
      path = join(dir, "fixture.sqlite");
      db.run("VACUUM INTO ?", [path]);
      parentDb = openSqliteDatabase(path) as unknown as SqlDatabase;
    }
    return { dir, parentDb, close: () => { if (parentDb !== db) parentDb.close(); },
      options: { ...build, process: { command: childCommand, env: {
        COPY_SYNTHETIC_TARGET: JSON.stringify({ dialect: db.dialect, path }),
        ...(failure ? { COPY_SYNTHETIC_FAILURE: failure } : {}),
      } } } };
  }

  test("launches four distinct PIDs and measures spawn through schema startup and readback to offline ready", async () => {
    const f = await processFixture();
    const previous = process.env.MULTIREMI_TOKEN;
    process.env.MULTIREMI_TOKEN = "synthetic-must-not-be-inherited";
    try {
      const result = await rehearseUnifiedModelCopy(f.parentDb, f.dir, undefined, f.options);
      expect(result.mismatches).toEqual([]);
      expect(result.partial_read_count).toBe(1);
      const startup = JSON.parse(readFileSync(join(f.dir, "copy-startup.json"), "utf8"));
      expect(startup.process_startup_measured).toBe(true);
      expect(startup.startup.map((s: any) => [s.role, s.phase, s.sample])).toEqual([
        ["api", "first_start", 1], ["api-runtime", "first_start", 1], ["api", "restart", 2], ["api-runtime", "restart", 2],
      ]);
      expect(new Set(startup.startup.map((s: any) => s.pid)).size).toBe(4);
      for (const s of startup.startup) {
        expect(s).toMatchObject({ mode: "offline_process", parent_pid: process.pid, source_sha: build.sourceSha,
          image_digest: build.imageDigest, unit: "ms", status: "success", completed: true, offline_ready: true,
          exit_code: 0, http_calls: 0, fetch_calls: 0, connection_open_measured: true });
        expect(s.pid).not.toBe(process.pid);
        const databaseMs = ["role_lock", "database_open", "run_migrations"]
          .reduce((sum, name) => sum + s.steps_ms[name], 0);
        expect(s.database_total_ms).toBe(databaseMs);
        expect(s.steps_ms.readback_validation).toBeGreaterThan(0);
        expect(s.startup_total_ms).toBeGreaterThanOrEqual(databaseMs + s.steps_ms.readback_validation);
        expect(s.attempt_total_ms).toBeGreaterThanOrEqual(s.startup_total_ms);
        expect(Date.parse(s.ready_at)).toBeGreaterThanOrEqual(Date.parse(s.started_at));
      }
      expect(startup.http_ready_measured).toBe(false);
      expect(startup.unmeasured).not.toContain("module loading and process/container cold start");
      const usage = JSON.parse(readFileSync(join(f.dir, "copy-usage-reconciliation.json"), "utf8"));
      expect(Object.keys(usage.snapshots)).toEqual(["before", "after_schema", "first_start_api", "first_start_api-runtime", "restart_api", "restart_api-runtime"]);
      expect(Object.values(usage.stages).every((s: any) => s.mismatches.length === 0)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_TOKEN;
      else process.env.MULTIREMI_TOKEN = previous;
      f.close();
    }
  }, 60_000);

  test("a child schema startup failure retains measured steps and PID without claiming ready or starting the next role", async () => {
    const f = await processFixture("gate");
    try {
      await expect(rehearseUnifiedModelCopy(f.parentDb, f.dir, undefined, f.options)).rejects.toThrow("offline startup not ready");
      const report = JSON.parse(readFileSync(join(f.dir, "copy-startup.json"), "utf8"));
      expect(report.startup).toHaveLength(1);
      expect(report.startup[0]).toMatchObject({ role: "api", phase: "first_start", status: "not_ready",
        completed: false, offline_ready: false, failed: true, failure_stage: "run_migrations", exit_code: 1,
        startup_total_ms: null, ready_at: null, unit: "ms", source_sha: build.sourceSha, image_digest: build.imageDigest,
        http_calls: 0, fetch_calls: 0 });
      expect(report.startup[0].pid).not.toBe(process.pid);
      expect(report.startup[0].steps_ms.run_migrations).toBeGreaterThan(0);
      expect(report.startup[0].steps_ms.readback_validation).toBeUndefined();
      expect(report.startup[0].attempt_total_ms).toBeGreaterThan(0);
      expect(readFileSync(join(f.dir, "startup-first_start-api.private.log"), "utf8")).toContain("synthetic schema startup failure");
    } finally { f.close(); }
  }, 30_000);

  test("content drift in child readback fails before ready and retains the changed usage stage", async () => {
    const f = await processFixture("readback");
    try {
      await expect(rehearseUnifiedModelCopy(f.parentDb, f.dir, undefined, f.options)).rejects.toThrow("Copy reconciliation failed");
      const report = JSON.parse(readFileSync(join(f.dir, "copy-startup.json"), "utf8"));
      expect(report.startup).toHaveLength(1);
      expect(report.startup[0]).toMatchObject({ offline_ready: false, completed: false, status: "not_ready",
        failure_stage: "readback_validation", startup_total_ms: null, ready_at: null });
      expect(report.startup[0].steps_ms.readback_validation).toBeGreaterThan(0);
      expect(report.startup[0].steps_ms.readback_validation).toBeGreaterThan(0);
      const usage = JSON.parse(readFileSync(join(f.dir, "copy-usage-reconciliation.json"), "utf8"));
      expect(usage.stages.after_schema.mismatches).toEqual([]);
      expect(usage.stages.first_start_api.changed_tables).toEqual(["multiremi_usage_units"]);
      expect(JSON.parse(readFileSync(join(f.dir, "copy-timing.json"), "utf8")).mismatches)
        .toContain("first_start_api: usage content changed: multiremi_usage_units");
    } finally { f.close(); }
  }, 30_000);

  test("checkpoint and Issue drift are rejected in the child before offline ready", async () => {
    const f = await processFixture("state");
    try {
      await expect(rehearseUnifiedModelCopy(f.parentDb, f.dir, undefined, f.options)).rejects.toThrow("offline startup not ready");
      const report = JSON.parse(readFileSync(join(f.dir, "copy-startup.json"), "utf8"));
      expect(report.startup).toHaveLength(1);
      expect(report.startup[0]).toMatchObject({ offline_ready: false, completed: false, status: "not_ready",
        failure_stage: "readback_validation", startup_total_ms: null, ready_at: null, http_calls: 0, fetch_calls: 0 });
      expect(report.startup[0].readback_mismatches.some((m: string) => m.startsWith("checkpoint generation:"))).toBe(true);
      expect(report.startup[0].readback_mismatches).toContain("stored Issue status/assignment/parent changed during startup");
    } finally { f.close(); }
  }, 30_000);

  test("a ready event followed by a nonzero child exit keeps measured time but fails the sample", async () => {
    const f = await processFixture("after_ready");
    try {
      await expect(rehearseUnifiedModelCopy(f.parentDb, f.dir, undefined, f.options)).rejects.toThrow("offline startup not ready");
      const report = JSON.parse(readFileSync(join(f.dir, "copy-startup.json"), "utf8"));
      expect(report.startup).toHaveLength(1);
      expect(report.startup[0]).toMatchObject({ offline_ready: false, completed: false, status: "not_ready",
        failure_stage: "process_exit", exit_code: 1, http_calls: 0, fetch_calls: 0 });
      expect(report.startup[0].startup_total_ms).toBeGreaterThan(0);
      expect(report.startup[0].attempt_total_ms).toBeGreaterThanOrEqual(report.startup[0].startup_total_ms);
      expect(report.startup[0].ready_at).not.toBeNull();
    } finally { f.close(); }
  }, 30_000);
});

test("a clean process exit without ready is not successful startup", async () => {
  const input = { role: "api", phase: "first_start", sample: 1, source_sha: build.sourceSha,
    image_digest: build.imageDigest, report_dir: output() } as CopyStartupInput;
  const result = await runCopyStartupProcess(input, { command: [process.execPath, "--no-env-file", "-e", "process.exit(0)"] });
  expect(result).toMatchObject({ offline_ready: false, completed: false, failed: true, status: "not_ready",
    startup_total_ms: null, ready_at: null, exit_code: 0, failure_stage: "exit_before_ready" });
  expect(result.pid).not.toBe(process.pid);
  expect(result.attempt_total_ms).toBeGreaterThan(0);
});

test("a ready signal without preceding readback validation cannot certify startup", async () => {
  const input = { role: "api", phase: "first_start", sample: 1, source_sha: build.sourceSha,
    image_digest: build.imageDigest, report_dir: output() } as CopyStartupInput;
  const command = `const input=JSON.parse(await Bun.stdin.text());process.send({event:"ready",timing:{
    role:input.role,phase:input.phase,sample:input.sample,source_sha:input.source_sha,image_digest:input.image_digest,
    pid:process.pid,offline_ready:true}});process.disconnect();`;
  const result = await runCopyStartupProcess(input, { command: [process.execPath, "--no-env-file", "-e", command] });
  expect(result).toMatchObject({ offline_ready: false, completed: false, failed: true, status: "not_ready",
    startup_total_ms: null, ready_at: null, exit_code: 0, failure_stage: "ready_protocol" });
});
