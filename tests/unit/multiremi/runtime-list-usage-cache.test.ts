import { expect, test } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { parseTaskUsageEntries } from "@multiremi/store/helpers.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

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

test("runtime list/detail usage matches frozen parser across cold, warm, invalidation, transactions and isolated runtimes", async () => {
  const database = await openHotspotDatabase();
  const db = database.db;
  const store = new MultiremiStore(db);
  try {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "usage golden", provider: "codex" });
    for (const id of ["rt_usage_a", "rt_usage_b", "rt_usage_empty"]) store.registerRuntime({ id, name: id, provider: "codex" });
    const statuses = ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human", "completed", "failed", "cancelled"];
    let sequence = 0;
    const insert = (runtimeId: string, status: string, usage: string | null) => {
      const id = `tsk_list_usage_${sequence++}`;
      db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, runtime_id, status, prompt, usage, created_at, updated_at)
        VALUES (?, 'local', ?, ?, ?, 'golden', ?, '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`, id, agent.id, runtimeId, status, usage);
      return id;
    };
    for (const status of statuses) for (const usage of usages) insert("rt_usage_a", status, usage);
    insert("rt_usage_b", "completed", '[{"inputTokens":19}]');
    const compare = () => {
      const runtimes = store.listRuntimesForWorkspace("local");
      for (const runtime of runtimes) {
        const rows = db.query("SELECT status, usage FROM multiremi_tasks WHERE runtime_id = ?").all(runtime.id);
        const expected = { taskCount: rows.length, activeTaskCount: 0, completedTaskCount: 0, failedTaskCount: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        for (const row of rows) {
          if (["dispatched", "running", "waiting_local_directory", "awaiting_human"].includes(row.status)) expected.activeTaskCount++;
          if (row.status === "completed") expected.completedTaskCount++;
          if (row.status === "failed") expected.failedTaskCount++;
          for (const entry of parseTaskUsageEntries(row.usage)) for (const field of fields.slice(4)) expected[field] += entry[field as "inputTokens"];
        }
        expect(Object.fromEntries(fields.map(field => [field, runtime[field]]))).toEqual(expected);
        expect(Object.fromEntries(fields.map(field => [field, store.getRuntime(runtime.id)![field]]))).toEqual(expected);
      }
    };
    compare(); compare();
    const changed = insert("rt_usage_a", "completed", '[{"inputTokens":13}]');
    compare();
    db.run("UPDATE multiremi_tasks SET usage = ?, status = 'running' WHERE id = ?", '[{"inputTokens":23}]', changed);
    compare();
    db.run("UPDATE multiremi_tasks SET status = 'completed', runtime_id = 'rt_usage_b' WHERE id = ?", changed);
    compare();
    db.transaction(() => {
      db.run("UPDATE multiremi_tasks SET usage = ? WHERE id = ?", '[{"inputTokens":31}]', changed); compare();
      db.run("UPDATE multiremi_tasks SET usage = ? WHERE id = ?", '[{"inputTokens":41}]', changed); compare();
    })();
    compare();
    expect(() => db.transaction(() => {
      db.run("UPDATE multiremi_tasks SET usage = ? WHERE id = ?", '[{"inputTokens":99}]', changed); compare();
      throw new Error("rollback");
    })()).toThrow("rollback");
    compare();
    db.run("DELETE FROM multiremi_tasks WHERE id = ?", changed); compare();
  } finally { await database.dispose(); }
});

test("runtime list keeps original addition order when token totals exceed safe integer precision", async () => {
  const database = await openHotspotDatabase();
  const store = new MultiremiStore(database.db);
  try {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "large token golden", provider: "codex" });
    store.registerRuntime({ id: "rt_large_usage", name: "large", provider: "codex" });
    for (const [index, status, inputTokens] of [[0, "completed", 1], [1, "running", 2 ** 53], [2, "completed", 1]] as const) {
      database.db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, runtime_id, status, prompt, usage, created_at, updated_at)
        VALUES (?, 'local', ?, 'rt_large_usage', ?, 'golden', ?, '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`,
        `tsk_large_usage_${index}`, agent.id, status, JSON.stringify([{ inputTokens }]));
    }
    const expected = database.db.query("SELECT usage FROM multiremi_tasks WHERE runtime_id = 'rt_large_usage'").all()
      .reduce((total, row) => total + parseTaskUsageEntries(row.usage).reduce((sum, entry) => sum + entry.inputTokens, 0), 0);
    expect(expected).toBe(2 ** 53);
    for (let i = 0; i < 2; i++) expect(store.listRuntimesForWorkspace("local")[0].inputTokens).toBe(expected);
  } finally { await database.dispose(); }
});
