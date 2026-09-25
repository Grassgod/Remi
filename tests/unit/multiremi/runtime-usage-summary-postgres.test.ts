/**
 * MUL-366: on PostgreSQL the runtime usage summary (task counts and token totals on every
 * hydrated runtime) no longer pulls each task's `usage` through the worker bridge on every read.
 * Counts come from SQL; settled tasks' token totals are cached per runtime under a version of
 * those rows, and only unsettled tasks' usage is read each time. Tokens are still summed by the JS
 * parser, and bun:sqlite keeps the plain scan, so the same fixture goes through both backends and
 * every field must match, including after the rows change.
 *
 * Skipped (not failed) when Postgres is unreachable, matching `multiremi-postgres-store.test.ts`.
 * Point `MULTIREMI_TEST_POSTGRES_URL` at an instance where the configured role may CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
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
    if (!sql.includes("open_usage")) return statement;
    const get = statement.get.bind(statement);
    statement.get = (...params: unknown[]) => {
      const row = get(...params);
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
    sqlite = new Database(":memory:");
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

  it("reads settled usage once and again only after those rows change", () => {
    pgStore.listRuntimes();
    pg.statements.length = 0;
    const listed = pgStore.listRuntimes().find((runtime) => runtime.id === pgRuntimes.runtimeA) ?? null;
    expect(usageSummary(listed)).toEqual(EXPECTED_RUNTIME_A);
    expect(pg.statements.some((sql) => sql.includes("open_usage"))).toBe(true);
    expect(pg.statements.some((sql) => sql.includes("settled_usage"))).toBe(false);
    expect(pg.statements.some((sql) => sql.includes(LEGACY_SCAN))).toBe(false);

    const settledRereads = (change: () => void) => {
      change();
      pg.statements.length = 0;
      expectBackendsAgree("runtimeA", "runtimeB");
      return pg.statements.filter((sql) => sql.includes("settled_usage")).length;
    };
    // Unsettled usage is read live, so its changes need no re-read.
    expect(settledRereads(() => mutate(
      "UPDATE multiremi_tasks SET usage = ? WHERE id = ?",
      () => [JSON.stringify([{ inputTokens: 40, outputTokens: 4 }]), "tsk_mul366_4"],
    ))).toBe(0);
    expect(settledRereads(() => mutate(
      "UPDATE multiremi_tasks SET usage = ? WHERE id = ?",
      () => [JSON.stringify([{ inputTokens: 5000, cacheReadTokens: 9 }]), "tsk_mul366_1"],
    ))).toBe(1);
    expect(settledRereads(() => mutate(
      "UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?",
      () => ["tsk_mul366_4"],
    ))).toBe(1);
    // Rewriting a settled row with identical values is still a new row version.
    expect(settledRereads(() => mutate(
      "UPDATE multiremi_tasks SET usage = usage WHERE id = ?",
      () => ["tsk_mul366_2"],
    ))).toBe(1);
    expect(settledRereads(() => mutate("DELETE FROM multiremi_tasks WHERE id = ?", () => ["tsk_mul366_2"]))).toBe(1);
    // Moving a settled task changes both runtimes.
    expect(settledRereads(() => mutate(
      "UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?",
      (runtimes) => [runtimes.runtimeB, "tsk_mul366_1"],
    ))).toBe(2);
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB)).inputTokens).toBe(6000);
    expect(settledRereads(() => mutate(
      `INSERT INTO multiremi_tasks
         (id, task_kind, agent_id, workspace_id, status, priority, prompt, attempt, max_attempts, holds_workspace,
          created_at, updated_at, runtime_id, usage)
       SELECT 'tsk_mul366_new', task_kind, agent_id, workspace_id, 'cancelled', priority, prompt, attempt, max_attempts,
              holds_workspace, created_at, updated_at, runtime_id, ?
       FROM multiremi_tasks WHERE id = ?`,
      () => [JSON.stringify([{ inputTokens: 70 }]), "tsk_mul366_3"],
    ))).toBe(1);
    expect(pg.statements.some((sql) => sql.includes(LEGACY_SCAN))).toBe(false);

    // Nothing changed since: no settled usage is read again.
    expect(settledRereads(() => {})).toBe(0);
  });

  it("rescans from one snapshot when a task settles between its two reads", () => {
    // A second store starts with a cold cache, so its first summary reads settled usage separately.
    const racing = new RecordingPostgresDb(url);
    try {
      const racingStore = new MultiremiStore(racing);
      const settle = [JSON.stringify([{ inputTokens: 800, outputTokens: 8 }]), "tsk_mul366_5"];
      racing.afterSummaryQuery = () => {
        racing.run("UPDATE multiremi_tasks SET status = 'completed', usage = ? WHERE id = ?", settle);
      };
      sqlite.run("UPDATE multiremi_tasks SET status = 'completed', usage = ? WHERE id = ?", settle);
      racing.statements.length = 0;
      const summary = usageSummary(racingStore.getRuntime(pgRuntimes.runtimeA));
      expect(racing.afterSummaryQuery).toBeNull();
      expect(racing.statements.some((sql) => sql.includes(LEGACY_SCAN))).toBe(true);
      expect(summary).toEqual(usageSummary(sqliteStore.getRuntime(sqliteRuntimes.runtimeA)));
      expect(usageSummary(racingStore.getRuntime(pgRuntimes.runtimeA))).toEqual(summary);
      expectBackendsAgree("runtimeA");
    } finally {
      racing.close();
    }
  }, 60_000);

  it("does not cache settled totals read between two writes in one transaction", () => {
    expectBackendsAgree("runtimeA");
    const sql = "UPDATE multiremi_tasks SET usage = ? WHERE id = ?";
    const usage = (inputTokens: number) => [JSON.stringify([{ inputTokens }]), "tsk_mul366_10"];
    pg.transaction(() => {
      pg.run(sql, usage(111));
      pg.statements.length = 0;
      pgStore.getRuntime(pgRuntimes.runtimeA);
      expect(pg.statements.some((statement) => statement.includes("settled_usage"))).toBe(true);
      // Same row, same transaction: the row keeps the `xmin` the read above saw.
      pg.run(sql, usage(222));
    })();
    sqlite.run(sql, usage(222));
    expectBackendsAgree("runtimeA");
  });
});
