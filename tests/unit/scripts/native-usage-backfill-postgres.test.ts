import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { actualUnit } from "../../../packages/acp/src/usage-collector.js";
import { exportCodexNativeUsage } from "../../../scripts/export-codex-native-usage.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const databaseName = `multiremi_native_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let admin: Bun.SQL | undefined, db: PostgresSyncDatabase | undefined, store: MultiremiStore, url = "";
const root = mkdtempSync(join(tmpdir(), "usage-native-pg-"));
const THREAD = "019a0000-0000-7000-8000-0000000000aa";
const usage = { input_tokens: 18_678, cached_input_tokens: 18_432, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 18_683 };
describe.skipIf(!adminUrl)("Codex native usage backfill through the PostgreSQL CLI", () => {
  beforeAll(async () => {
    if (!adminUrl || !/^multiremi_native_pg_\d+_\d+$/.test(databaseName)) throw new Error("Invalid isolated database target");
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`; url = target.toString();
    db = new PostgresSyncDatabase(url);
    store = new MultiremiStore(db); store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    db?.close();
    if (admin && /^multiremi_native_pg_\d+_\d+$/.test(databaseName)) { await admin.unsafe(`DROP DATABASE ${databaseName}`); await admin.end(); }
    if (!root.startsWith(join(tmpdir(), "usage-native-pg-"))) throw new Error("Unexpected test fixture path");
    rmSync(root, { recursive: true });
  });
  const cli = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, "run", "scripts/reconcile-task-usage.ts", ...args], {
      cwd: process.cwd(), env: { ...process.env, MULTIREMI_DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  };
  it("plans in a read-only snapshot, then applies and verifies the reviewed plan", async () => {
    const agent = store.createAgent({ name: "codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "synthetic v6 attempt" });
    runTurnExecutionMutation(db!, "UPDATE multiremi_turn_execution_records SET status='completed',provider='codex',session_id=?,started_at='2026-10-12T00:00:00Z',completed_at='2026-10-12T01:00:00Z',usage='[]' WHERE id=?", [THREAD, task.id]);
    writeUsageSnapshot(db!, task.id, { version: 2, runId: "run-v6", revision: 2, complete: true, units: [{
      ...actualUnit({ unitId: "context:run-v6", provider: "codex", scope: "turn", source: "context_snapshot", accuracy: "unknown" }),
      contextTokens: 18_683, contextWindow: 475_000, occurredAt: "2026-10-12T00:30:00.000Z" }] }, { historical: true });
    const rollout = join(root, "workspaces", ".runtime", "chat_a", agent.id, "1", "home", "sessions", "2026", "10", "12", `rollout-2026-10-12T00-00-00-${THREAD}.jsonl`);
    mkdirSync(join(rollout, ".."), { recursive: true });
    writeFileSync(rollout, [{ timestamp: "2026-10-12T00:00:01.000Z", type: "session_meta", payload: { id: THREAD } },
      { timestamp: "2026-10-12T00:30:00.000Z", type: "token_usage_record", payload: { thread_id: THREAD, session_id: THREAD, turn_id: "turn", response_id: "resp_v6", usage } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const evidence = join(root, "daemon-a.json"), planFile = join(root, "plan.json");
    await Bun.write(evidence, JSON.stringify(await exportCodexNativeUsage({ workspacesRoots: [join(root, "workspaces")], host: "daemon-a" })));

    const summary = cli(`--native-evidence=${evidence}`, `--task-id=${task.id}`, `--out=${planFile}`);
    expect(summary).toMatchObject({ mode: "read-only", modernRepairCount: 1, modernAfterActualTokens: 18_683,
      nativeBackfill: { counts: { requests: 1, attributed: 1 }, outcomes: { repaired: { tasks: 1, requests: 1, actualTokens: 18_683 } } } });
    expect(Number(db!.query("SELECT COUNT(*) AS units FROM multiremi_usage_units WHERE task_id=?").get(task.id).units)).toBe(1);
    expect(() => cli(`--apply-plan=${planFile}`, "--execute")).toThrow("--confirm=USAGE_EVIDENCE_V2");
    expect(cli(`--apply-plan=${planFile}`, "--execute", "--confirm=USAGE_EVIDENCE_V2")).toMatchObject({ applied: { applied: 1, resumed: 0 }, verified: { tasks: 1, actualTokens: 18_683 } });
    expect(cli(`--verify-plan=${planFile}`)).toMatchObject({ verified: { tasks: 1, actualTokens: 18_683 } });
    expect((db!.query("SELECT provider_session_id,provider_request_id,identity_kind,input_tokens,cache_read_tokens,output_tokens FROM multiremi_usage_units WHERE task_id=? AND source='provider_request'").all(task.id) as any[])
      .map(row => ({ ...row, input_tokens: Number(row.input_tokens), cache_read_tokens: Number(row.cache_read_tokens), output_tokens: Number(row.output_tokens) })))
      .toEqual([{ provider_session_id: THREAD, provider_request_id: "resp_v6", identity_kind: "request", input_tokens: 246, cache_read_tokens: 18_432, output_tokens: 5 }]);
  }, 60_000);
});
