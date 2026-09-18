import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const CREATED_AT = "2026-09-18T00:00:00.000Z";
const thinking = {
  status: "supported" as const,
  supportedLevels: [{ value: "high", label: "high" }],
  defaultLevel: "high",
};

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    name: "Pagination worker", provider: "codex", maxConcurrency: 1,
    models: [{ id: "available", label: "Available", provider: "codex", default: true, thinking }],
  });
  const runnable = store.createAgent({ name: "Runnable", provider: "codex", model: "available", thinkingLevel: "high" });
  const blocked = store.createAgent({ name: "Blocked", provider: "codex", model: "unavailable", thinkingLevel: "high" });
  return { store, runtime, runnable, blocked };
}

function sameTimeTask(store: ReturnType<typeof createLocalStore>, agentId: string, id: string) {
  const task = store.createTask({ agentId, prompt: id });
  // Use controlled identifiers so lexical order cannot accidentally agree with
  // insertion order. Direct tasks here have no child/plugin snapshot rows.
  db!.run("UPDATE multiremi_tasks SET id = ?, created_at = ? WHERE id = ?", [id, CREATED_AT, task.id]);
  return id;
}

describe("frozen task candidate pagination order", () => {
  it("preserves SQLite first-created order when timestamps tie and IDs sort oppositely", () => {
    const { store, runtime, runnable } = fixture();
    const ids = ["tsk_z_first", "tsk_m_second", "tsk_a_third"].map(id => sameTimeTask(store, runnable.id, id));
    for (const id of ids) {
      expect(store.claimTask(runtime.id)?.id).toBe(id);
      store.startTask(id);
      store.completeTask(id, { output: "complete in creation order" });
    }
  });

  it("does not lose runnable work across tied page boundaries when a database varies unspecified ties", () => {
    const { store, runtime, runnable, blocked } = fixture();
    for (let index = 0; index < 128; index++) {
      sameTimeTask(store, blocked.id, `tsk_a_${String(index).padStart(3, "0")}`);
    }
    const wanted = sameTimeTask(store, runnable.id, "tsk_z_runnable");
    const originalQuery = db!.query.bind(db!);
    let pageQueries = 0;
    const query = spyOn(db!, "query").mockImplementation((sql: string) => {
      if (/FROM multiremi_tasks t\s/.test(sql) && /LIMIT 128 OFFSET \?/.test(sql)) {
        pageQueries++;
        // Both orders satisfy priority/time alone. Engines may pick different
        // bounded-sort plans for OFFSET 0 and OFFSET 128, even under a lock.
        // Only resolve genuinely unspecified ties: a production full ordering
        // is left untouched. With the old query, the runnable row is excluded
        // from page 1, then moves before page 2's offset and is never examined.
        sql = sql.replace(
          /(ORDER BY t\.priority DESC,\s*t\.created_at ASC)(\s+LIMIT 128 OFFSET \?)/,
          `$1, t.id ${pageQueries === 1 ? "ASC" : "DESC"}$2`,
        );
      }
      return originalQuery(sql);
    });
    try {
      expect(store.claimTask(runtime.id)?.id).toBe(wanted);
      expect(pageQueries).toBe(2);
    } finally {
      query.mockRestore();
    }
  });

  it("reaches the first runnable tied task beyond two full pages and preserves the next task", () => {
    const { store, runtime, runnable, blocked } = fixture();
    for (let index = 0; index < 257; index++) {
      sameTimeTask(store, blocked.id, `tsk_blocked_${String(index).padStart(3, "0")}`);
    }
    const first = sameTimeTask(store, runnable.id, "tsk_z_first_runnable");
    const second = sameTimeTask(store, runnable.id, "tsk_a_second_runnable");
    expect(store.claimTask(runtime.id)?.id).toBe(first);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.startTask(first);
    store.completeTask(first, { output: "first completed" });
    expect(store.claimTask(runtime.id)?.id).toBe(second);
  });
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const pgAvailable = await (async () => {
  const probe = new Bun.SQL(pgAdminUrl, { max: 1 });
  try { await probe`SELECT 1`; return true; }
  catch (error) {
    if (process.env.MULTIREMI_TEST_POSTGRES_URL) throw error;
    return false;
  } finally { await probe.end(); }
})();

describe.skipIf(!pgAvailable)("frozen task pagination on PostgreSQL", () => {
  const databaseName = `multiremi_page_order_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let admin: InstanceType<typeof Bun.SQL>;
  let pg: PostgresSyncDatabase;
  let store: MultiremiStore;
  beforeAll(async () => {
    admin = new Bun.SQL(pgAdminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(pgAdminUrl);
    url.pathname = `/${databaseName}`;
    pg = new PostgresSyncDatabase(url.toString());
    store = new MultiremiStore(pg);
    store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    pg?.close();
    if (admin) {
      try { await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });

  it("uses stable ID ties across pages independently of heap insertion order", () => {
    const runtime = store.registerRuntime({
      name: "Postgres page worker", provider: "codex", maxConcurrency: 1,
      models: [{ id: "available", label: "Available", provider: "codex", default: true, thinking }],
    });
    const blocked = store.createAgent({ name: "Blocked", provider: "codex", model: "unavailable", thinkingLevel: "high" });
    const runnable = store.createAgent({ name: "Runnable", provider: "codex", model: "available", thinkingLevel: "high" });
    // Populate tied native candidates in one insert to keep this real-engine
    // regression focused on claiming rather than hundreds of setup roundtrips.
    pg.run(`INSERT INTO multiremi_tasks
      (id, agent_id, provider, workspace_id, prompt, created_at, updated_at)
      SELECT 'tsk_a_' || LPAD(n::text, 3, '0'), ?, 'codex', 'local', 'blocked', ?, ?
      FROM generate_series(1, 128) AS n`, [blocked.id, CREATED_AT, CREATED_AT]);
    for (const id of ["tsk_z_second", "tsk_y_first"]) {
      const task = store.createTask({ agentId: runnable.id, prompt: id });
      pg.run("UPDATE multiremi_tasks SET id = ?, created_at = ? WHERE id = ?", [id, CREATED_AT, task.id]);
    }
    expect(store.claimTask(runtime.id)?.id).toBe("tsk_y_first");
    store.startTask("tsk_y_first");
    store.completeTask("tsk_y_first", { output: "deterministic tie order" });
    expect(store.claimTask(runtime.id)?.id).toBe("tsk_z_second");
  }, 15_000);
});
