/**
 * MUL-357 on real PostgreSQL. Every other piece of evidence for this change is
 * bun:sqlite (in-process `:memory:`), while production runs PostgreSQL, so this
 * file re-checks the four things that can differ per backend:
 *
 *  1. the migration's two `CREATE INDEX` statements survive `splitStatements`
 *     plus `translateSqliteToPg` and really land in `pg_indexes` / their
 *     `indexdef` really matches `ORDER BY created_at DESC, id DESC`;
 *  2. PostgreSQL's planner picks those indexes for the statements the route
 *     issues (a Seq Scan plus Sort here is the same bug, just relocated);
 *  3. `?` → `$n` translation keeps status / cursor / limit bound in the right
 *     order, which a miscounted placeholder would otherwise satisfy silently;
 *  4. paging the API returns the same authorized set the parent commit's
 *     unpaginated filter returned.
 *
 * Skipped (not failed) when Postgres is unreachable, matching
 * `multiremi-postgres-store.test.ts`. Point `MULTIREMI_TEST_POSTGRES_URL` at an
 * instance where the configured role may CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, translateSqliteToPg } from "@multiremi/store/db/postgres.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul357_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[mul357-pg] Postgres not reachable at ${PG_ADMIN_URL} — skipping the PostgreSQL pagination checks.`,
  );
}

/**
 * Record the SQL a route asks the store for. Statements are built per call, so
 * the recording has to happen in `query()`, not by stubbing the bridge.
 */
class RecordingDb implements SqlDatabase {
  readonly statements: string[] = [];
  constructor(private readonly inner: SqlDatabase) {}
  query(sql: string): SqlStatement {
    this.statements.push(sql);
    return this.inner.query(sql);
  }
  prepare(sql: string): SqlStatement {
    this.statements.push(sql);
    return this.inner.prepare(sql);
  }
  run(sql: string, ...params: unknown[]) { return this.inner.run(sql, ...params); }
  exec(sql: string): void { this.inner.exec(sql); }
  transaction<T>(fn: (...args: any[]) => T) { return this.inner.transaction(fn); }
  close(): void { this.inner.close(); }
}

describe.skipIf(!pgAvailable)("Task list pagination on PostgreSQL (MUL-357)", () => {
  let db: PostgresSyncDatabase;
  let recorder: RecordingDb;
  let store: MultiremiStore;
  let sql: InstanceType<typeof Bun.SQL>;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${TEST_DB}`;
    // Constructing the store runs migrate(); every CREATE TABLE / CREATE INDEX
    // goes through translateSqliteToPg, so a mis-translation throws here.
    db = new PostgresSyncDatabase(url.toString());
    recorder = new RecordingDb(db);
    store = new MultiremiStore(recorder);
    store.ensureLocalWorkspace();
    sql = new Bun.SQL(url.toString(), { max: 2 });
  });

  afterAll(async () => {
    try { await sql?.end(); } catch { /* connection may already be gone */ }
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  async function explain(statement: string, params: unknown[]) {
    const translated = translateSqliteToPg(statement);
    const rows = await sql.unsafe(`EXPLAIN (ANALYZE) ${translated}`, params as any[]);
    const text = rows.map((row: any) => row["QUERY PLAN"]).join("\n");
    return {
      indexes: [...text.matchAll(/Index (?:Only )?Scan(?: Backward)? using (\S+)/g)].map((match) => match[1]!),
      seqScanOnTasks: /Seq Scan on multiremi_tasks/.test(text),
      sortNode: /(^|\n)\s+Sort\b/m.test(text),
      text,
    };
  }

  it("applies both pagination indexes on PostgreSQL", async () => {
    const created = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='multiremi_tasks'
        AND indexname IN ('idx_multiremi_tasks_created_at','idx_multiremi_tasks_status_created')
      ORDER BY indexname`;
    expect(created.map((row: any) => row.indexname)).toEqual([
      "idx_multiremi_tasks_created_at",
      "idx_multiremi_tasks_status_created",
    ]);
    // Both sort columns are DESC and in route order, which is what lets the
    // planner satisfy `ORDER BY created_at DESC, id DESC` from the index.
    for (const row of created as any[]) {
      expect(String(row.indexdef)).toContain("created_at DESC");
      expect(String(row.indexdef)).toContain("id DESC");
    }
    const recorded = await sql`
      SELECT id FROM multiremi_schema_migrations WHERE id = '20260921_task_list_pagination_indexes'`;
    expect(recorded).toHaveLength(1);
  });

  it("plans the route's page statements through those indexes, not a scan plus sort", async () => {
    const agent = store.createAgent({ name: "MUL-357 agent", provider: "codex", workspaceId: "local", visibility: "workspace" });
    // Insert the bulk pool straight into the table: it only exists to give the
    // planner realistic statistics, and per-task store writes are PG round trips.
    // Production's status mix is dominated by `completed`, so both groups are
    // large enough for the planner to consider an index that preserves order.
    const values: string[] = [];
    const params: unknown[] = [];
    const pushTask = (id: string, status: string, createdAt: string) => {
      const base = params.length;
      values.push(`($${base + 1},'direct',$${base + 2},'local',$${base + 3},0,$${base + 4},1,3,1,$${base + 5},$${base + 5})`);
      params.push(id, agent.id, status, `pooled ${id} ${"x".repeat(200)}`, createdAt);
    };
    for (let index = 0; index < 4000; index += 1) {
      pushTask(`tsk_pgdone_${index}`, "completed", new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString());
    }
    for (let index = 0; index < 2000; index += 1) {
      pushTask(`tsk_pgrun_${index}`, "running", new Date(Date.UTC(2026, 6, 1) + index * 1000).toISOString());
    }
    await sql.unsafe(
      `INSERT INTO multiremi_tasks
         (id, task_kind, agent_id, workspace_id, status, priority, prompt, attempt, max_attempts, holds_workspace, created_at, updated_at)
       VALUES ${values.join(",")}`,
      params as any[],
    );
    // A selective status group: production has a handful of `running`/`queued`
    // rows too, and the planner is allowed to prefer the pre-existing
    // single-column `status` index there. Only a whole-table scan + sort is a bug.
    for (let index = 0; index < 3; index += 1) {
      const task = store.createTask({ agentId: agent.id, prompt: `queued ${index}`, workspaceId: "local" });
      recorder.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", ["queued", task.id]);
    }
    await sql.unsafe("ANALYZE multiremi_tasks");

    // Re-issue exactly what the route issued, captured from the store.
    recorder.statements.length = 0;
    store.listTasksChunk(undefined, null, 200);
    const unfilteredStatement = recorder.statements.find((statement) => statement.includes("ORDER BY created_at DESC, id DESC"))!;
    expect(unfilteredStatement).toBeDefined();
    const unfiltered = await explain(unfilteredStatement, [200]);
    expect(unfiltered.seqScanOnTasks).toBe(false);
    expect(unfiltered.sortNode).toBe(false);
    expect(unfiltered.indexes).toContain("idx_multiremi_tasks_created_at");

    // Status-filtered page with a large matching group: `status` leads the
    // composite index, so the order comes from the index instead of a sort.
    recorder.statements.length = 0;
    store.listTasksChunk("running", null, 200);
    const filteredStatement = recorder.statements.find((statement) => statement.includes("status = ?"))!;
    expect(filteredStatement).toBeDefined();
    const filtered = await explain(filteredStatement, ["running", 200]);
    expect(filtered.seqScanOnTasks).toBe(false);
    expect(filtered.indexes).toContain("idx_multiremi_tasks_status_created");

    // Selective status group: either index is acceptable, a Seq Scan is not.
    const selective = await explain(filteredStatement, ["queued", 200]);
    expect(selective.seqScanOnTasks).toBe(false);
  }, 120_000);

  it("binds status, cursor and limit in the order the query shape requires", async () => {
    const agent = store.createAgent({ name: "MUL-357 binding", provider: "codex", workspaceId: "local", visibility: "workspace" });
    const seeded: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const task = store.createTask({ agentId: agent.id, prompt: `done ${index}`, workspaceId: "local" });
      recorder.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", ["completed", task.id]);
      seeded.push(task.id);
    }
    for (let index = 0; index < 3; index += 1) {
      store.createTask({ agentId: agent.id, prompt: `queued ${index}`, workspaceId: "local" });
    }

    // Other tasks exist in this database, so walk pages by cursor and pick out
    // this fixture's rows; what matters is that they come back in order, once
    // each, and never mixed with another status.
    //
    // MUL-357 made the chunk read a narrow candidate projection (guard columns
    // only) with the full row loaded separately by `hydrateTasksByIds`. The
    // status filter still has to hold -- a swapped status/limit binding would
    // let another status through -- so status is asserted on the hydrated
    // rows, and the two phases are required to correspond one to one.
    const seen: string[] = [];
    let cursor: import("@multiremi/store/repos/tasks-repo.js").TaskListCursor | null = null;
    const statusesSeen = new Set<string>();
    for (let page = 0; page < 12; page += 1) {
      const chunk = store.listTasksChunk("completed", cursor, 3);
      // The candidate scan returns guard columns only, so the status check runs
      // on the hydrated rows -- that is exactly the phase-two read the route
      // performs, so a swapped binding still shows up here.
      for (const task of store.hydrateTasksByIds(chunk.tasks.map((candidate) => candidate.id))) {
        statusesSeen.add(task.status);
        if (seeded.includes(task.id)) seen.push(task.id);
      }
      if (!chunk.nextCursor) break;
      cursor = chunk.nextCursor;
    }
    // A swapped status/limit binding would filter on the wrong column, return
    // another status, or repeat rows across pages.
    expect([...statusesSeen]).toEqual(["completed"]);
    expect(seen).toEqual([...seeded].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  }, 60_000);

  it("pages the API to the same authorized set the unpaginated read returns", async () => {
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
    // Reference set: what the unpaginated route returned on the parent commit,
    // computed here with the same two guards the route applies.
    //
    // Read through the narrow `id/status/runtime_id/agent_id` projection: this
    // fixture is >8 MB of full task rows, and since MUL-386 C.1 the bridge
    // legitimately refuses a reply that size. The id set is what this comparison
    // needs, so the projection is equivalent here — and that refusal is itself
    // the guardrail working.
    const reference = store.listTaskRefs({ statuses: [] }).map((task) => task.id);
    const collected: string[] = [];
    let offset = 0;
    // The fixture is ~6k rows, so a cap of 100 pages at limit=100 is generous.
    for (let page = 0; page < 100; page += 1) {
      const response = await app.request(`/api/multiremi/tasks?limit=100&offset=${offset}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        tasks: Array<{ id: string }>;
        has_more: boolean;
        next_offset: number | null;
      };
      collected.push(...body.tasks.map((task: any) => task.id));
      if (!body.has_more) break;
      expect(page, "page walk did not terminate").toBeLessThan(99);
      expect(body.next_offset).toBe(offset + body.tasks.length);
      offset = body.next_offset!;
    }
    // The parent commit returned the whole table from this route; the page walk
    // must not drop or repeat a row.
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.length).toBe(reference.length);
    expect(new Set(collected)).toEqual(new Set(reference));
  }, 120_000);
});
