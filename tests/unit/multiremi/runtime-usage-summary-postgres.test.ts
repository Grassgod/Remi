/** Runtime summaries use one canonical scalar SQL snapshot on PostgreSQL and SQLite. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { writeUsageSnapshot, validateUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { parseTaskUsageEntries } from "@multiremi/store/helpers.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import type { MultiremiRuntime } from "@multiremi/contracts/types.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul366_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

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
    `[mul366-pg] Postgres not reachable at ${PG_ADMIN_URL} — skipping the PostgreSQL runtime usage checks.`,
  );
}

/** Subclass rather than wrap, so the store still recognizes the Postgres backend. */
class RecordingPostgresDb extends PostgresSyncDatabase {
  readonly statements: string[] = [];
  /** Runs once, right after the next usage summary query returns. */
  afterSummaryQuery: (() => void) | null = null;
  override query(sql: string): SqlStatement {
    this.statements.push(sql);
    const statement = super.query(sql);
    if (!sql.includes("WITH selected AS")) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...params: unknown[]) => {
      const row = all(...params);
      const hook = this.afterSummaryQuery;
      this.afterSummaryQuery = null;
      hook?.();
      return row;
    };
    return statement;
  }
}

// [status, raw `usage` column text]. Every shape `parseTaskUsageEntries` accepts or rejects.
const RUNTIME_A_TASKS: Array<[string, string]> = [
  ["completed", JSON.stringify([{
    provider: "codex", model: "gpt-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 7, totalTokens: 1557,
  }])],
  ["completed", JSON.stringify([
    { provider: "codex", model: "gpt-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { provider: "codex", model: "gpt-5-mini", inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1 },
  ])],
  ["failed", "[]"],
  // Legacy snake_case keys, missing field.
  ["running", JSON.stringify([{ provider: "claude", model: "opus", input_tokens: 11, output_tokens: 5, cache_read_tokens: 2 }])],
  // JSON null falls through to snake_case; fractions floor; negatives clamp; numeric strings parse.
  ["dispatched", JSON.stringify([{ inputTokens: null, input_tokens: 4, outputTokens: 2.9, cacheReadTokens: -8, cacheWriteTokens: "12" }])],
  // Whitespace-padded string, boolean true, garbage string, object.
  ["waiting_local_directory", JSON.stringify([{ inputTokens: " 7 ", outputTokens: true, cacheReadTokens: "abc", cacheWriteTokens: {} }])],
  // Non-object entries are skipped; a present camelCase 0 wins over snake_case.
  ["awaiting_human", JSON.stringify([5, "x", null, [1], { inputTokens: 3, outputTokens: 0, output_tokens: 50 }])],
  ["queued", "not json"],
  ["cancelled", JSON.stringify({ inputTokens: 99 })],
  ["completed", "null"],
  ["completed", ""],
];

const EXPECTED_RUNTIME_A = {
  taskCount: 11,
  activeTaskCount: 4,
  completedTaskCount: 4,
  failedTaskCount: 1,
  inputTokens: 1200 + 100 + 10 + 11 + 4 + 7 + 3,
  outputTokens: 300 + 20 + 2 + 5 + 2 + 1 + 0,
  cacheReadTokens: 50 + 0 + 1 + 2 + 0 + 0,
  cacheWriteTokens: 7 + 0 + 1 + 0 + 12 + 0,
};

// Inputs `Number()` and `JSON.parse` treat differently from PostgreSQL's numeric and jsonb parsers,
// which is why the Postgres path still sums tokens in JS.
const RUNTIME_D_USAGE: string[] = [
  JSON.stringify([{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }]),
  // Unicode whitespace (numeric casts only trim ASCII), tab, hex and exponent strings.
  JSON.stringify([{ inputTokens: "　12", outputTokens: "\t5", cacheReadTokens: "0x10", cacheWriteTokens: "1e3" }]),
  JSON.stringify([{ inputTokens: [7], outputTokens: -3, cacheReadTokens: true, cacheWriteTokens: false }]),
  // Escapes JSON.parse accepts and jsonb rejects.
  JSON.stringify([{ model: "gpt\ud83d", inputTokens: 100 }]),
  JSON.stringify([{ model: "gpt\u0000", inputTokens: 200 }]),
  // Beyond double precision and range.
  `[{"inputTokens": 5.99999999999999999999, "outputTokens": 1e400}]`,
  // Long text, and nesting deep enough to overflow PostgreSQL's parser.
  JSON.stringify([{ inputTokens: 9, model: "m".repeat(17_000) }]),
  `[{"inputTokens": 4, "nested": ${"[".repeat(20_000)}${"]".repeat(20_000)}}]`,
  // A numeric-string entry next to a plain number.
  JSON.stringify([{ inputTokens: 10 }, { inputTokens: "2" }]),
];

function referenceTokens(usages: string[]) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of usages) {
    for (const entry of parseTaskUsageEntries(usage)) {
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadTokens += entry.cacheReadTokens;
      totals.cacheWriteTokens += entry.cacheWriteTokens;
    }
  }
  return totals;
}

function usageSummary(runtime: MultiremiRuntime | null) {
  expect(runtime).not.toBeNull();
  const {
    taskCount, activeTaskCount, completedTaskCount, failedTaskCount,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  } = runtime!;
  return {
    taskCount, activeTaskCount, completedTaskCount, failedTaskCount,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  };
}

function canonical(db: SqlDatabase, taskId: string, raw: string, occurredAt = "2026-09-24T00:00:00.000Z") {
  const entries = parseTaskUsageEntries(raw);
  writeUsageSnapshot(db, taskId, { version: 2, runId: "fixture", revision: 1, complete: true,
    units: entries.map((entry, index) => ({ unitId: String(index), revision: 1, provider: "codex", model: "fixture-model", modelSource: "provider_reported",
      source: "provider_request", scope: "request", accuracy: "exact", inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens, cacheWriteTokens: entry.cacheWriteTokens, actualUnsplitTokens: 0,
      reportedTotalTokens: entry.totalTokens, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt })) });
}

function seed(store: MultiremiStore, db: SqlDatabase) {
  store.ensureLocalWorkspace();
  const runtimeA = store.registerRuntime({ name: "Busy runtime", provider: "codex" });
  const runtimeB = store.registerRuntime({ name: "Other runtime", provider: "claude" });
  const runtimeC = store.registerRuntime({ name: "Idle runtime", provider: "codex" });
  const runtimeD = store.registerRuntime({ name: "Legacy runtime", provider: "codex" });
  const agent = store.createAgent({ name: "MUL-366 agent", provider: "codex", workspaceId: "local" });
  let index = 0;
  const insert = (runtimeId: string, status: string, usage: string) => {
    index += 1;
    const createdAt = new Date(Date.UTC(2026, 8, 24) + index * 1000).toISOString();
    db.run(
      `INSERT INTO multiremi_tasks
         (id, task_kind, agent_id, workspace_id, status, priority, prompt, attempt, max_attempts, holds_workspace,
          created_at, updated_at, runtime_id, usage)
       VALUES (?, 'direct', ?, 'local', ?, 0, ?, 1, 3, 1, ?, ?, ?, ?)`,
      [`tsk_mul366_${index}`, agent.id, status, `usage fixture ${index}`, createdAt, createdAt, runtimeId, usage],
    );
    canonical(db, `tsk_mul366_${index}`, usage, createdAt);
  };
  for (const [status, usage] of RUNTIME_A_TASKS) insert(runtimeA.id, status, usage);
  insert(runtimeB.id, "completed", JSON.stringify([{ provider: "claude", model: "opus", inputTokens: 1000, outputTokens: 1 }]));
  insert(runtimeB.id, "running", "[]");
  for (const usage of RUNTIME_D_USAGE) insert(runtimeD.id, "completed", usage);
  return { runtimeA: runtimeA.id, runtimeB: runtimeB.id, runtimeC: runtimeC.id, runtimeD: runtimeD.id };
}

describe.skipIf(!pgAvailable)("Runtime usage summary on PostgreSQL (MUL-366)", () => {
  let url: string;
  let pg: RecordingPostgresDb;
  let pgStore: MultiremiStore;
  let pgRuntimes: ReturnType<typeof seed>;
  let sqlite: Database;
  let sqliteStore: MultiremiStore;
  let sqliteRuntimes: ReturnType<typeof seed>;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const parsed = new URL(PG_ADMIN_URL);
    parsed.pathname = `/${TEST_DB}`;
    url = parsed.toString();
    pg = new RecordingPostgresDb(url);
    pgStore = new MultiremiStore(pg);
    pgRuntimes = seed(pgStore, pg);
    sqlite = openSqliteDatabase(":memory:");
    sqliteStore = new MultiremiStore(sqlite);
    sqliteRuntimes = seed(sqliteStore, sqlite);
  }, 120_000);

  afterAll(async () => {
    pg?.close();
    sqlite?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  const LEGACY_SCAN = "SELECT id, status, usage FROM multiremi_tasks";
  type Runtimes = ReturnType<typeof seed>;

  /** Applies the same raw write to both backends. */
  function mutate(sql: string, params: (runtimes: Runtimes) => string[]) {
    pg.run(sql, params(pgRuntimes));
    sqlite.run(sql, params(sqliteRuntimes));
  }

  function expectBackendsAgree(...keys: Array<keyof Runtimes>) {
    for (const key of keys) {
      expect(usageSummary(pgStore.getRuntime(pgRuntimes[key])))
        .toEqual(usageSummary(sqliteStore.getRuntime(sqliteRuntimes[key])));
    }
  }

  it("matches the JS reference implementation field for field", () => {
    const pgA = usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA));
    const sqliteA = usageSummary(sqliteStore.getRuntime(sqliteRuntimes.runtimeA));
    expect(sqliteA).toEqual(EXPECTED_RUNTIME_A);
    expect(pgA).toEqual(sqliteA);
    for (const value of Object.values(pgA)) expect(typeof value).toBe("number");

    expectBackendsAgree("runtimeB");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB))).toMatchObject({
      taskCount: 2, activeTaskCount: 1, completedTaskCount: 1, inputTokens: 1000, outputTokens: 1,
    });
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeC))).toEqual({
      taskCount: 0, activeTaskCount: 0, completedTaskCount: 0, failedTaskCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("matches JS on usage PostgreSQL would parse differently", () => {
    const expected = {
      taskCount: RUNTIME_D_USAGE.length,
      activeTaskCount: 0,
      completedTaskCount: RUNTIME_D_USAGE.length,
      failedTaskCount: 0,
      ...referenceTokens(RUNTIME_D_USAGE),
    };
    expect(expected.inputTokens).toBeGreaterThan(300);
    expect(usageSummary(sqliteStore.getRuntime(sqliteRuntimes.runtimeD))).toEqual(expected);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeD))).toEqual(expected);
  });

  it("reads scalar facts for every list and detail, without legacy JSON or stale caches", () => {
    pg.statements.length = 0;
    const listed = pgStore.listRuntimesForWorkspace("local").find(runtime => runtime.id === pgRuntimes.runtimeA) ?? null;
    expect(usageSummary(listed)).toEqual(EXPECTED_RUNTIME_A);
    expect(pg.statements.filter(sql => sql.includes("WITH selected AS")).length).toBe(1);
    expect(pg.statements.some(sql => /json_agg|settled_usage|open_usage/.test(sql))).toBe(false);
    // Legacy audit text cannot change normal statistics.
    mutate("UPDATE multiremi_tasks SET usage=? WHERE id=?", () => ['[{"inputTokens":999999}]', "tsk_mul366_1"]);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA))).toEqual(EXPECTED_RUNTIME_A);
    mutate("UPDATE multiremi_usage_units SET input_tokens=? WHERE task_id=?", () => ["5000", "tsk_mul366_1"]);
    expectBackendsAgree("runtimeA");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(EXPECTED_RUNTIME_A.inputTokens - 1200 + 5000);
    mutate("UPDATE multiremi_tasks SET status='completed' WHERE id=?", () => ["tsk_mul366_4"]);
    expectBackendsAgree("runtimeA");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).activeTaskCount).toBe(3);
    mutate("DELETE FROM multiremi_tasks WHERE id=?", () => ["tsk_mul366_2"]);
    expectBackendsAgree("runtimeA");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).taskCount).toBe(10);
  });

  it("keeps old consumption on its original runtime after reassignment", () => {
    const beforeA = usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA));
    const beforeB = usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB));
    mutate("UPDATE multiremi_tasks SET runtime_id=? WHERE id=?", runtimes => [runtimes.runtimeB, "tsk_mul366_1"]);
    expectBackendsAgree("runtimeA", "runtimeB");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(beforeA.inputTokens);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB)).inputTokens).toBe(beforeB.inputTokens);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).taskCount).toBe(beforeA.taskCount);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB)).taskCount).toBe(beforeB.taskCount + 1);
  });

  it("returns one coherent snapshot when a concurrent fact update follows the query", () => {
    const racing = new RecordingPostgresDb(url);
    try {
      const racingStore = new MultiremiStore(racing);
      const before = usageSummary(racingStore.getRuntime(pgRuntimes.runtimeA));
      racing.afterSummaryQuery = () => racing.run("UPDATE multiremi_usage_units SET input_tokens=800 WHERE task_id='tsk_mul366_5'");
      racing.statements.length = 0;
      expect(usageSummary(racingStore.getRuntime(pgRuntimes.runtimeA))).toEqual(before);
      expect(racing.afterSummaryQuery).toBeNull();
      expect(racing.statements.filter(sql => sql.includes("WITH selected AS")).length).toBe(1);
      sqlite.run("UPDATE multiremi_usage_units SET input_tokens=800 WHERE task_id='tsk_mul366_5'");
      expectBackendsAgree("runtimeA");
      expect(usageSummary(racingStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(before.inputTokens - 4 + 800);
    } finally { racing.close(); }
  }, 60_000);

  it("sees each write inside one transaction and never publishes a rolled-back cache", () => {
    const sql = "UPDATE multiremi_usage_units SET input_tokens=? WHERE task_id=?";
    const before = usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens;
    expect(() => pg.transaction(() => {
      pg.run(sql, [111, "tsk_mul366_4"]);
      expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(before - 11 + 111);
      pg.run(sql, [222, "tsk_mul366_4"]);
      expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(before - 11 + 222);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens).toBe(before);
    expectBackendsAgree("runtimeA");
  });

  it("retains large safe integers and rejects unsafe native facts before persistence", () => {
    const value = 2 ** 52 + 1;
    mutate("UPDATE multiremi_usage_units SET input_tokens=? WHERE task_id=?", () => [String(value), "tsk_mul366_3"]);
    // The failed task had no unit; use a measured task instead.
    mutate("UPDATE multiremi_usage_units SET input_tokens=? WHERE task_id=?", () => [String(value), "tsk_mul366_4"]);
    expectBackendsAgree("runtimeA");
    expect(Number.isSafeInteger(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA)).inputTokens)).toBe(true);
    const sample = { version: 2 as const, runId: "unsafe", revision: 1, complete: true, units: [{ unitId: "bad", revision: 1,
      provider: "codex", model: "m", source: "provider_request" as const, scope: "request" as const, accuracy: "exact" as const,
      inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0,
      reportedTotalTokens: null, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-09-24T00:00:00Z" }] };
    expect(() => validateUsageSnapshot(sample)).toThrow("inputTokens");
  });
});
