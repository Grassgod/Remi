import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { createReplacementAttemptWithinTransaction } from "@multiremi/store/turn-attempts.js";
import { actualUnit, requestUnitId } from "../../../packages/acp/src/usage-collector.js";
import { ZipStreamWriter } from "../../../packages/shared/src/zip/writer.js";
import { buildReconcileUsagePlan } from "../../../scripts/reconcile-task-usage.js";
import { applyUsageReconciliation, verifyUsageReconciliation } from "../../../scripts/usage-reconciliation-store.js";
import { applyModernUsageRepairs, buildModernUsageRepairs, readModernRepairState } from "../../../scripts/modern-usage-repair.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `multiremi_repair_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let admin: Bun.SQL | undefined, sql: Bun.SQL | undefined, db: PostgresSyncDatabase | undefined, store: MultiremiStore;
const root = mkdtempSync(join(tmpdir(), "usage-modern-pg-"));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const at = "2026-10-01T01:00:00.000Z";
describe.skipIf(!adminUrl)("modern repair PostgreSQL plan and synchronous apply", () => {
  beforeAll(async () => {
    if (!adminUrl || !/^multiremi_repair_pg_\d+_\d+$/.test(databaseName)) throw new Error("Invalid isolated database target");
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
    db = new PostgresSyncDatabase(url.toString());
    store = new MultiremiStore(db); store.ensureLocalWorkspace();
    sql = new Bun.SQL(url.toString(), { max: 1 });
  });
  afterAll(async () => {
    await sql?.end(); db?.close();
    if (admin && /^multiremi_repair_pg_\d+_\d+$/.test(databaseName)) { await admin.unsafe(`DROP DATABASE ${databaseName}`); await admin.end(); }
    if (!root.startsWith(join(tmpdir(), "usage-modern-pg-"))) throw new Error("Unexpected test fixture path");
    rmSync(root, { recursive: true });
  });
  it("rejects a missing execution projection through direct apply, reconciliation and CLI before any DDL", async () => {
    const agent = store.createAgent({ name: "schema gate", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "schema rejection" });
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',provider='claude',session_id='schema-session',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [task.id]);
    const early = { ...actualUnit({ unitId: requestUnitId("response", "schema-session"), provider: "claude", providerSessionId: "schema-session", providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 }), occurredAt: at };
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 1, complete: true, units: [early] }, { historical: true });
    const plan = await buildReconcileUsagePlan(sql!, { taskId: task.id });
    plan.modernRepairs = buildModernUsageRepairs(readModernRepairState(db!, task.id), [{ ...early, outputTokens: 11, reportedTotalTokens: 41, accuracy: "exact", actualUnsplitTokens: 0 }], []);
    expect(plan.modernRepairs).toHaveLength(1);
    const planFile = join(root, "unsupported-plan.json");
    await Bun.write(planFile, JSON.stringify(plan));
    const tables = db!.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name").all();
    const units = db!.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(task.id);
    const projection = db!.query("SELECT pg_get_viewdef('multiremi_turn_execution_records'::regclass) AS definition").get().definition as string;
    db!.exec("DROP VIEW multiremi_turn_execution_records");
    try {
      expect(() => applyModernUsageRepairs(db!, plan.modernRepairs!, "missing-schema")).toThrow("Unsupported usage reconciliation schema");
      expect(() => applyUsageReconciliation(db!, plan)).toThrow("Unsupported usage reconciliation schema");
      const url = new URL(adminUrl!); url.pathname = `/${databaseName}`;
      const child = Bun.spawnSync([process.execPath, "run", "scripts/reconcile-task-usage.ts", `--apply-plan=${planFile}`, "--execute", "--confirm=USAGE_EVIDENCE_V2"], {
        cwd: process.cwd(), env: { ...process.env, MULTIREMI_DATABASE_URL: url.toString() }, stdout: "pipe", stderr: "pipe",
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("Unsupported usage reconciliation schema");
      expect(child.stderr.toString()).toContain("startup migration");
      expect(db!.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name").all()).toEqual(tables);
      expect(db!.query("SELECT * FROM multiremi_usage_units WHERE task_id=? ORDER BY run_id,unit_id").all(task.id)).toEqual(units);
    } finally { db!.exec(`CREATE VIEW multiremi_turn_execution_records AS ${projection}`); }
  }, 30_000);
  for (const provider of ["claude", "codex"]) it(`generates, applies, verifies and resumes ${provider} corrections through real drivers`, async () => {
    const session = `native-${provider}`;
    const agent = store.createAgent({ name: provider, provider });
    const task = store.createTask({ agentId: agent.id, prompt: "synthetic archived evidence" });
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='failed',provider=?,session_id=?,started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [provider, session, task.id]);
    const early = provider === "claude"
      ? actualUnit({ unitId: requestUnitId("response", session), provider, providerSessionId: session, providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 })
      : actualUnit({ unitId: `request:${session}:epoch:0:${JSON.stringify({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 1, totalTokens: 31 })}`, provider, scope: "request", source: "provider_request", accuracy: "unknown", evidenceRef: "codex_meter_epoch_unresolved" });
    early.occurredAt = at;
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "live-run", revision: 2, complete: true, units: [early] }, { historical: true });
    const rows = provider === "claude" ? [{ type: "assistant", timestamp: at, sessionId: session, message: { id: "response", stop_reason: "end_turn", model: "actual-model", usage: { input_tokens: 10, output_tokens: 11, cache_read_input_tokens: 20 } } }]
      : [{ type: "session_meta", payload: { id: session } }, { type: "event_msg", timestamp: "2026-10-01T00:30:00Z", payload: { type: "task_started", turn_id: "real-turn" } }, { type: "token_usage_record", timestamp: at, payload: { thread_id: session, turn_id: "real-turn", response_id: "response", usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 }, turn_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 11, total_tokens: 41 } } },
        { type: "event_msg", timestamp: "2026-10-01T01:30:00Z", payload: { type: "task_complete", turn_id: "real-turn" } }];
    const buffers: Buffer[] = [], writer = new ZipStreamWriter({ write: chunk => { buffers.push(chunk); } });
    const body = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const member = await writer.addBuffer("native/session.jsonl", body, hash(body.toString()));
    const index = Buffer.from(JSON.stringify({ format: "multiremi.session-archive.v2", subject: { kind: "task", id: task.id }, members: [{ path: member.path, kind: "provider", local_header_offset: member.localHeaderOffset, data_offset: member.dataOffset, compressed_size: member.compressedSize, uncompressed_size: member.uncompressedSize, sha256: member.sha256 }] }));
    await writer.addBuffer("index.json", index, hash(index.toString())); await writer.finish();
    const filename = `${provider}.zip`; await Bun.write(join(root, filename), Buffer.concat(buffers));
    db!.run(`INSERT INTO multiremi_session_archives(id,workspace_id,subject_kind,subject_id,format,runtime_id,daemon_id,source_revision,sha256,size_bytes,status,relative_path,created_at,updated_at,completed_at) VALUES(?,'local','task',?,'multiremi.session-archive.v2','synthetic-runtime','synthetic-daemon','synthetic-source',?,?,'ready',?,?,?,?)`, [`archive-${provider}`, task.id, hash(body.toString()), body.length, filename, at, at, at]);
    const plan = await sql!.begin(async tx => { await tx.unsafe("SET TRANSACTION READ ONLY"); return buildReconcileUsagePlan(tx, { archiveRoot: root, taskId: task.id }); });
    expect(plan.tasks).toHaveLength(0); expect(plan.modernRepairs).toHaveLength(1);
    expect(plan.modernRepairs![0]!.afterActualTokens).toBe(41);
    if (provider === "codex") expect(plan.modernRepairs![0]!.coverage).toBe("complete_native_turn");
    const original = readModernRepairState(db!, task.id);
    expect(plan.modernRepairs![0]!.expectedTurnId).toBe(original.task.turn_id);
    const other = store.createTask({ agentId: agent.id, prompt: "different turn" });
    const otherTurn = db!.query("SELECT turn_id FROM multiremi_turn_attempts WHERE id=?").get(other.id).turn_id;
    db!.run("UPDATE multiremi_turn_attempts SET turn_id=?,attempt_no=2 WHERE id=?", [otherTurn, task.id]);
    const moved = readModernRepairState(db!, task.id);
    expect(() => applyUsageReconciliation(db!, plan)).toThrow("changed after plan");
    expect(readModernRepairState(db!, task.id)).toEqual(moved);
    expect(db!.query("SELECT task_id FROM multiremi_usage_modern_repair_audit WHERE task_id=?").all(task.id)).toEqual([]);
    db!.run("UPDATE multiremi_turn_attempts SET turn_id=?,attempt_no=? WHERE id=?", [original.task.turn_id, original.task.attempt, task.id]);
    const retry = db!.transaction(() => createReplacementAttemptWithinTransaction(db!, original.task.turn_id, { previousStatus: "failed", reason: "retry" }))();
    expect(retry.attempt_no).toBe(2);
    expect(readModernRepairState(db!, task.id).task).toEqual(original.task);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 1, resumed: 0 });
    expect(verifyUsageReconciliation(db!, plan).tasks).toBe(1);
    expect(applyUsageReconciliation(db!, plan)).toMatchObject({ applied: 0, resumed: 1 });
    const updated = await buildReconcileUsagePlan(sql!, { archiveRoot: root, taskId: task.id });
    expect(updated.modernRepairs).toHaveLength(0);
  }, 30_000);
});
