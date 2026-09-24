/**
 * MUL-366: on PostgreSQL the runtime usage summary (task counts and token totals on every
 * hydrated runtime) is aggregated in SQL instead of pulling each task's `usage` through the
 * worker bridge. bun:sqlite still runs the original JS implementation, so the same fixture goes
 * through both backends and every field must match, including the malformed and legacy usage
 * shapes the JS parser tolerates.
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
  readonly results: Array<{ sql: string; row: Record<string, unknown> | null }> = [];
  override query(sql: string): SqlStatement {
    this.statements.push(sql);
    const statement = super.query(sql);
    const get = statement.get.bind(statement);
    statement.get = (...params: unknown[]) => {
      const row = get(...params);
      this.results.push({ sql, row });
      return row;
    };
    return statement;
  }
}

/** Reports a pre-16 server, which lacks `pg_input_is_valid`. */
class LegacyPostgresDb extends RecordingPostgresDb {
  override query(sql: string): SqlStatement {
    if (sql.includes("server_version_num")) {
      this.statements.push(sql);
      return { get: () => ({ version: "150013" }) } as unknown as SqlStatement;
    }
    return super.query(sql);
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

// The rows of runtime A the SQL cannot sum exactly (fractions, strings, invalid JSON, empty text).
const RUNTIME_A_FALLBACK = [RUNTIME_A_TASKS[4]![1], RUNTIME_A_TASKS[5]![1], RUNTIME_A_TASKS[7]![1], RUNTIME_A_TASKS[10]![1]];

// Inputs `Number()` and `JSON.parse` treat differently from PostgreSQL's numeric and jsonb parsers.
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
  // Past the SQL length guard: long text, and nesting deep enough to overflow PostgreSQL's parser.
  JSON.stringify([{ inputTokens: 9, model: "m".repeat(17_000) }]),
  `[{"inputTokens": 4, "nested": ${"[".repeat(20_000)}${"]".repeat(20_000)}}]`,
  // One odd entry sends the whole task to JS.
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

  const aggregateRow = () => [...pg.results].reverse().find((result) => result.sql.includes("fallback_usage"))!.row!;

  it("matches the JS reference implementation field for field", () => {
    const pgA = usageSummary(pgStore.getRuntime(pgRuntimes.runtimeA));
    const sqliteA = usageSummary(sqliteStore.getRuntime(sqliteRuntimes.runtimeA));
    expect(sqliteA).toEqual(EXPECTED_RUNTIME_A);
    expect(pgA).toEqual(sqliteA);
    for (const value of Object.values(pgA)) expect(typeof value).toBe("number");

    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB)))
      .toEqual(usageSummary(sqliteStore.getRuntime(sqliteRuntimes.runtimeB)));
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeB))).toMatchObject({
      taskCount: 2, activeTaskCount: 1, completedTaskCount: 1, inputTokens: 1000, outputTokens: 1,
    });
    expect(usageSummary(pgStore.getRuntime(pgRuntimes.runtimeC))).toEqual({
      taskCount: 0, activeTaskCount: 0, completedTaskCount: 0, failedTaskCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("matches JS on inputs PostgreSQL parses differently, without raising", () => {
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
    expect(JSON.parse(String(aggregateRow().fallback_usage))).toHaveLength(RUNTIME_D_USAGE.length - 1);
  });

  it("sums writer-shaped usage in SQL and hands only other shapes to JS", () => {
    pg.statements.length = 0;
    const listed = pgStore.listRuntimes().find((runtime) => runtime.id === pgRuntimes.runtimeA) ?? null;
    expect(usageSummary(listed)).toEqual(EXPECTED_RUNTIME_A);
    expect(pg.statements.some((sql) => sql.includes("SELECT id, status, usage FROM multiremi_tasks"))).toBe(false);
    expect(pg.statements.some((sql) => sql.includes("jsonb_array_elements"))).toBe(true);

    pgStore.getRuntime(pgRuntimes.runtimeA);
    expect((JSON.parse(String(aggregateRow().fallback_usage)) as string[]).sort()).toEqual([...RUNTIME_A_FALLBACK].sort());
    pgStore.getRuntime(pgRuntimes.runtimeB);
    expect(aggregateRow().fallback_usage).toBeNull();
    expect(Number(aggregateRow().input_tokens)).toBe(1000);
  });

  it("keeps the JS path on PostgreSQL releases without pg_input_is_valid", () => {
    const legacy = new LegacyPostgresDb(url);
    try {
      const legacyStore = new MultiremiStore(legacy);
      legacy.statements.length = 0;
      expect(usageSummary(legacyStore.getRuntime(pgRuntimes.runtimeA))).toEqual(EXPECTED_RUNTIME_A);
      expect(legacy.statements.some((sql) => sql.includes("SELECT id, status, usage FROM multiremi_tasks"))).toBe(true);
      expect(legacy.statements.some((sql) => sql.includes("jsonb_array_elements"))).toBe(false);
    } finally {
      legacy.close();
    }
  }, 60_000);
});
