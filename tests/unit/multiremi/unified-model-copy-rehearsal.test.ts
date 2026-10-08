import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rehearseUnifiedModelCopy, validateCopyDatabaseUrl } from "../../../scripts/rehearse-unified-model-copy.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { ensureUsageAccountingSchema, writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { prepareUsageAccountingStartup } from "@multiremi/store/usage-migration.js";
import { collectCopyUsageSnapshot, reconcileCopyUsage } from "../../../scripts/unified-model-copy-usage.js";

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
  ensureUsageAccountingSchema(historical);
  await prepareUsageAccountingStartup(historical);
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
    expect(result.startup.every((s: any) => s.completed && s.steps_ms.prepare_usage > 0 && s.steps_ms.ensure_usage > 0)).toBe(true);
    expect(result.http_ready_measured).toBe(false);
    const usage = JSON.parse(readFileSync(join(dir, "copy-usage-reconciliation.json"), "utf8"));
    expect(usage.snapshots.before.markers).toHaveLength(2);
    expect(usage.snapshots.before.tables.multiremi_usage_legacy_versions.count).toBeGreaterThan(0);
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
    db.run("UPDATE multiremi_usage_legacy_audit SET original_usage=? WHERE task_id=?", [longBody, task.id]);
    const before = collectCopyUsageSnapshot(db, "multiremi_tasks");
    db.run("UPDATE multiremi_usage_legacy_audit SET original_usage=? WHERE task_id=?", [longBody.slice(0, -1) + "X", task.id]);
    const after = collectCopyUsageSnapshot(db, "multiremi_tasks");
    expect(after.tables.multiremi_usage_legacy_audit.count).toBe(before.tables.multiremi_usage_legacy_audit.count);
    expect(reconcileCopyUsage(before, after).changed_tables).toEqual(["multiremi_usage_legacy_audit"]);
    const altered = structuredClone(before);
    altered.tables.multiremi_usage_legacy_audit.orphan_task_refs = 1;
    altered.markers = [];
    altered.unit_evidence = [{ actual_tokens: 999, cost_amount: 99 }];
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage attempt attribution missing: multiremi_usage_legacy_audit");
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage cutover markers changed");
    expect(reconcileCopyUsage(before, altered).mismatches).toContain("usage actual/context/unknown/money evidence changed");
  });

  test("keeps failed usage gate timing and stops before the next role or restart", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "gate failure", provider: "codex" });
    store.createTask({ agentId: agent.id, prompt: "history", status: "completed" });
    await prepareHistoricalUsage(db);
    const failing = new Proxy(db, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (sql.includes("SELECT t.id FROM multiremi_turn_execution_records t LEFT JOIN multiremi_usage_legacy_sources")) {
          throw new Error("synthetic usage gate failure");
        }
        return target.query(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const dir = output();
    await expect(rehearseUnifiedModelCopy(failing, dir)).rejects.toThrow("synthetic usage gate failure");
    const report = JSON.parse(readFileSync(join(dir, "copy-startup.json"), "utf8"));
    expect(report.startup).toHaveLength(1);
    expect(report.startup[0]).toMatchObject({ role: "api", phase: "first_start", failed: true, completed: false });
    expect(report.startup[0].steps_ms.prepare_usage).toBeGreaterThan(0);
    expect(report.startup[0].steps_ms.ensure_usage).toBeUndefined();
    expect(report.http_ready_measured).toBe(false);
  });

  test("fails rehearsal on same-count usage content drift and retains per-stage mismatch evidence", async () => {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "startup drift", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "history", status: "completed" });
    await prepareHistoricalUsage(db);
    let changed = false;
    const drifting = new Proxy(db, { get(target, key) {
      if (key === "query") return (sql: string) => {
        if (!changed && sql.includes("SELECT t.id FROM multiremi_turn_execution_records t LEFT JOIN multiremi_usage_legacy_sources")) {
          target.run("UPDATE multiremi_usage_legacy_audit SET original_usage='unexpected content change' WHERE task_id=?", [task.id]);
          changed = true;
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
    expect(usage.stages.first_start_api.changed_tables).toEqual(["multiremi_usage_legacy_audit"]);
    expect(JSON.parse(readFileSync(join(dir, "copy-timing.json"), "utf8")).mismatches)
      .toContain("first_start_api: usage content changed: multiremi_usage_legacy_audit");
  });
});
