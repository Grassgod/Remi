import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { parseTaskUsageEntries } from "@multiremi/store/helpers.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { readProcessDbCounters } from "../../../packages/server/src/observability/request-metrics.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";

function seedUsageAttempt(db: SqlDatabase, id: string, agentId: string, runtimeId: string, status: string, usage: string | null) {
  const stamp = "2026-10-05T00:00:00Z";
  const turnId = `turn_${id}`;
  db.run(`INSERT INTO multiremi_turns (id, session_id, seq, workspace_id, agent_id, status, current_attempt_id, created_at)
    VALUES (?, ?, 1, 'local', ?, ?, ?, ?)`, turnId, `chat_${id}`, agentId,
    status === "queued" ? "pending" : ["completed", "failed", "cancelled", "awaiting_human"].includes(status) ? status : "running", id, stamp);
  db.run(`INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, runtime_id, status, usage, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)`, id, turnId, runtimeId,
    status === "queued" ? "offered" : status === "dispatched" ? "accepted" : status === "awaiting_human" ? "running" : status, usage, stamp, stamp);
}

const fields = ["taskCount", "activeTaskCount", "completedTaskCount", "failedTaskCount", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
// The schema rejects SQL NULL in usage; JSON null remains part of the persisted golden.
const usages = ["", "not json", "null", '{}', '[]',
  '[1,null,"x",[1],{}]',
  '[{"inputTokens":0,"input_tokens":99,"outputTokens":null,"output_tokens":7,"cacheReadTokens":2.9,"cache_write_tokens":-3}]',
  '[{"input_tokens":"　12","outputTokens":"0x10","cache_read_tokens":"1e3","cacheWriteTokens":true}]',
  '[{"inputTokens":[7],"outputTokens":{},"cacheReadTokens":false,"totalTokens":100}]',
  '[{"inputTokens":1,"inputTokens":2},{"inputTokens":3}]',
  '[{"model":"\\ud83d","inputTokens":100},{"model":"\\u0000","outputTokens":200}]',
  '[{"inputTokens":5.999999999999999999,"outputTokens":1e400}]',
  '[{"inputTokens":4,"nested":' + '['.repeat(20000) + ']'.repeat(20000) + '}]',
];

function persist(db: SqlDatabase, id: string, raw: string) {
  const revision = Number((db.query("SELECT revision FROM multiremi_usage_runs WHERE task_id=? AND run_id='fixture'").get(id) as { revision: number } | null)?.revision ?? 0) + 1;
  writeUsageSnapshot(db, id, { version: 2, runId: "fixture", revision, complete: true, units: parseTaskUsageEntries(raw).map((entry,index) => ({
    unitId: String(index), revision, provider: "codex", model: "fixture-model", source: "provider_request", scope: "request", accuracy: "exact",
    inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, cacheReadTokens: entry.cacheReadTokens, cacheWriteTokens: entry.cacheWriteTokens,
    actualUnsplitTokens: 0, reportedTotalTokens: entry.totalTokens, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-05T00:00:00Z",
  })) });
}
function expectedSummary(db: SqlDatabase, runtimeId: string) {
  const rows = db.query("SELECT id,status FROM multiremi_turn_execution_records WHERE runtime_id=?").all(runtimeId) as Array<{ id: string; status: string }>;
  const units = db.query("SELECT u.task_id,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens FROM multiremi_usage_units u JOIN multiremi_turn_execution_records t ON t.id=u.task_id WHERE u.runtime_id=?").all(runtimeId) as Array<Record<string, unknown>>;
  const expected = { taskCount: new Set([...rows.map(row => row.id), ...units.map(row => String(row.task_id))]).size,
    activeTaskCount: rows.filter(row => ["dispatched","running","waiting_local_directory","awaiting_human"].includes(row.status)).length,
    completedTaskCount: rows.filter(row => row.status==='completed').length, failedTaskCount: rows.filter(row => row.status==='failed').length,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const row of units) { expected.inputTokens += Number(row.input_tokens ?? 0); expected.outputTokens += Number(row.output_tokens ?? 0);
    expected.cacheReadTokens += Number(row.cache_read_tokens ?? 0); expected.cacheWriteTokens += Number(row.cache_write_tokens ?? 0); }
  return expected;
}

describe("runtime list canonical facts", () => {
  let database: Awaited<ReturnType<typeof openHotspotDatabase>> | undefined;
  let db: SqlDatabase;
  let store: MultiremiStore;
  const disposeFixture = async () => {
    const current = database;
    database = undefined;
    await current?.dispose();
  };
  // Schema/database creation has its own fixture budget, as for the open-usage suite below.
  beforeAll(async () => {
    try {
      database = await openHotspotDatabase();
      db = database.db;
      store = new MultiremiStore(db);
    } catch (error) { await disposeFixture(); throw error; }
  }, 30_000);
  afterAll(disposeFixture);

  test("runtime list/detail uses canonical facts across repeated reads, revisions, transactions and isolated runtimes", () => {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "usage golden", provider: "codex" });
    for (const id of ["rt_usage_a", "rt_usage_b", "rt_usage_empty"]) store.registerRuntime({ id, name: id, provider: "codex" });
    const statuses = ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human", "completed", "failed", "cancelled"];
    let sequence = 0;
    const insert = (runtimeId: string, status: string, usage: string | null) => {
      const id = `tsk_list_usage_${sequence++}`;
      seedUsageAttempt(db, id, agent.id, runtimeId, status, usage);
      persist(db, id, usage ?? "[]");
      return id;
    };
    db.transaction(() => {
      for (const status of statuses) for (const usage of usages) insert("rt_usage_a", status, usage);
      insert("rt_usage_b", "completed", '[{"inputTokens":19}]');
    })();
    const compare = () => {
      const runtimes = store.listRuntimesForWorkspace("local");
      for (const runtime of runtimes) {
        const expected = expectedSummary(db, runtime.id);
        expect(Object.fromEntries(fields.map(field => [field, runtime[field]]))).toEqual(expected);
        expect(Object.fromEntries(fields.map(field => [field, store.getRuntime(runtime.id)![field]]))).toEqual(expected);
      }
    };
    compare(); compare();
    const changed = insert("rt_usage_a", "completed", '[{"inputTokens":13}]');
    compare();
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ?, status = 'running' WHERE id = ?", '[{"inputTokens":23}]', changed);
    persist(db, changed, '[{"inputTokens":23}]');
    compare();
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status = 'completed', runtime_id = 'rt_usage_b' WHERE id = ?", changed);
    compare();
    db.transaction(() => {
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = ?", '[{"inputTokens":31}]', changed); persist(db, changed, '[ {"inputTokens":31} ]'); compare();
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = ?", '[{"inputTokens":41}]', changed); persist(db, changed, '[ {"inputTokens":41} ]'); compare();
    })();
    compare();
    expect(() => db.transaction(() => {
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = ?", '[{"inputTokens":99}]', changed); persist(db, changed, '[ {"inputTokens":99} ]'); compare();
      throw new Error("rollback");
    })()).toThrow("rollback");
    compare();
    db.run("DELETE FROM multiremi_turn_attempts WHERE id = ?", changed); compare();
  });
});

describe("runtime list open-usage fixture", () => {
  let database: Awaited<ReturnType<typeof openHotspotDatabase>> | undefined;
  let db: SqlDatabase;
  let store: MultiremiStore;
  const disposeFixture = async () => {
    const resource = database;
    database = undefined;
    await resource?.dispose();
  };

  // Creating a disposable PG database and installing the full platform schema
  // is fixture setup, independent of the list/read and mutation checks below.
  beforeAll(async () => {
    try {
      database = await openHotspotDatabase();
      db = database.db;
      store = new MultiremiStore(db);
    } catch (error) {
      await disposeFixture();
      throw error;
    }
  });
  afterAll(disposeFixture);

  test("unchanged open usage has bounded bridge bytes and mutations remain immediately visible", () => {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "open usage golden", provider: "codex" });
    for (let i = 0; i < 10; i++) store.registerRuntime({ id: `rt_open_${i}`, name: `open ${i}`, provider: "codex", maxConcurrency: 32 });
    db.transaction(() => {
      for (let i = 0; i < 200; i++) { seedUsageAttempt(db, `tsk_open_${i}`, agent.id, `rt_open_${i % 10}`, "running", JSON.stringify([{ inputTokens: 1234, output_tokens: 567,
          cacheReadTokens: 89, cache_write_tokens: 10, model: "m".repeat(300) }]));
        persist(db, `tsk_open_${i}`, JSON.stringify([{ inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 10 }]));
      }
    })();
    const compare = () => {
      const before = readProcessDbCounters();
      const runtimes = store.listRuntimesForWorkspace("local");
      const bridgeBytes = readProcessDbCounters().dbBytes - before.dbBytes;
      for (const runtime of runtimes) {
        const expected = expectedSummary(db, runtime.id);
        expect(Object.fromEntries(fields.map(field => [field, runtime[field]]))).toEqual(expected);
      }
      return bridgeBytes;
    };
    compare(); // cold read
    if (db instanceof PostgresSyncDatabase) expect(compare()).toBeLessThanOrEqual(50000);
    else compare();
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = 'tsk_open_0'", usages[6]); persist(db, "tsk_open_0", usages[6]!); compare();
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET status = 'completed' WHERE id = 'tsk_open_1'"); compare();
    runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET runtime_id = 'rt_open_9' WHERE id = 'tsk_open_2'"); compare();
    db.transaction(() => {
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = 'tsk_open_3'", usages[7]); persist(db, "tsk_open_3", usages[7]!); compare();
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = 'tsk_open_3'", usages[8]); persist(db, "tsk_open_3", usages[8]!); compare();
    })(); compare();
    expect(() => db.transaction(() => {
      runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET usage = ? WHERE id = 'tsk_open_4'", '[{"inputTokens":99999}]'); persist(db, "tsk_open_4", '[ {"inputTokens":99999} ]'); compare();
      throw new Error("open rollback");
    })()).toThrow("open rollback"); compare();
    db.run("DELETE FROM multiremi_turn_attempts WHERE id = 'tsk_open_5'"); compare();
    db.run("DELETE FROM multiremi_turn_attempts WHERE runtime_id = 'rt_open_6'"); compare();
    if (db instanceof PostgresSyncDatabase) expect(compare()).toBeLessThanOrEqual(50000);
  });
});

test("native telemetry rejects unsafe counts and scalar totals preserve large safe integers", async () => {
  const database = await openHotspotDatabase(), db = database.db, store = new MultiremiStore(db);
  try {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "large token golden", provider: "codex" });
    store.registerRuntime({ id: "rt_large_usage", name: "large", provider: "codex" });
    for (const [index,inputTokens] of [[0,1],[1,2 ** 52],[2,1]] as const) {
      const id = `tsk_large_usage_${index}`;
      seedUsageAttempt(db, id, agent.id, "rt_large_usage", "completed", "[]");
      persist(db, id, JSON.stringify([{ inputTokens }]));
    }
    expect(store.listRuntimesForWorkspace("local")[0]?.inputTokens).toBe(2 ** 52 + 2);
    expect(() => persist(db, "tsk_large_usage_0", JSON.stringify([{ inputTokens: 2 ** 53 }]))).toThrow("inputTokens");
    expect(store.getRuntime("rt_large_usage")?.inputTokens).toBe(2 ** 52 + 2);
  } finally { await database.dispose(); }
});
