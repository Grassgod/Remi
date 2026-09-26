/**
 * The read-only pool's four acceptance cases from MUL-439:
 * saturation → 503, client abort, non-`SELECT` rejection, and the SQLite
 * degradation.
 *
 * The Postgres cases need a real server: the pool's whole job is to bound what
 * a real connection does (statement timeout, session read-only, connection
 * acquisition). Skipped, with a warning, when none is reachable — the same
 * convention `multiremi-postgres-store.test.ts` uses. Point
 * `MULTIREMI_TEST_POSTGRES_URL` at an instance where the role may CREATE
 * DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createReadPool,
  isReadOnlySelect,
  PostgresReadPool,
  readPoolErrorStatus,
  ReadPoolNotSelectError,
  ReadPoolSaturatedError,
  ReadPoolTimeoutError,
  READ_POOL_QUEUE_LIMIT,
  SqliteReadPool,
  type ReadPool,
} from "@multiremi/store/db/read-pool.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

const PG_ADMIN_URL =
  process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul439_read_pool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

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
    `[mul439-read-pool] Postgres not reachable at ${PG_ADMIN_URL} — skipping the pool's Postgres checks.`,
  );
}

describe("read pool: the SELECT gate", () => {
  it("accepts reads and rejects everything that writes", () => {
    for (const sql of [
      "SELECT 1",
      "  select a from t where b = ?",
      "/* leading */ SELECT 1",
      "-- comment\nSELECT 1",
      "WITH recent AS (SELECT 1) SELECT * FROM recent",
      "VALUES (1), (2)",
      "EXPLAIN SELECT 1",
      "TABLE multiremi_tasks",
    ]) {
      expect(isReadOnlySelect(sql), `${sql} should be a read`).toBe(true);
    }

    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "CREATE TABLE t (a int)",
      "ALTER TABLE t ADD COLUMN b int",
      "DROP TABLE t",
      "TRUNCATE t",
      "GRANT ALL ON t TO x",
      "VACUUM",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "SET default_transaction_read_only = off",
      "SELECT 1 INTO new_table",
      "SELECT 1; DROP TABLE t",
      "WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x",
      "EXPLAIN ANALYZE SELECT 1",
      "",
      "   ",
    ]) {
      expect(isReadOnlySelect(sql), `${JSON.stringify(sql)} should be rejected`).toBe(false);
    }
  });

  it("does not trip over identifiers that merely contain a write keyword", async () => {
    // `updated_at`/`updated_by` are on nearly every table; a substring match
    // would reject the store's own queries.
    for (const sql of [
      "SELECT updated_at, created_at, updated_by FROM multiremi_tasks",
      "SELECT deleted_at FROM multiremi_conversation_log WHERE session_id = ?",
      "SELECT * FROM multiremi_issue_sessions ORDER BY last_activity_at DESC",
    ]) {
      expect(isReadOnlySelect(sql), `${sql} should be a read`).toBe(true);
    }
  });

  it("rejects a write before it ever reaches a connection", async () => {
    const sqlite = new SqliteReadPool(new Database(":memory:") as unknown as SqlDatabase);
    await expect(sqlite.query("DELETE FROM multiremi_tasks")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
  });
});

describe("read pool: error → status mapping", () => {
  it("maps saturation and timeout to 503", () => {
    expect(readPoolErrorStatus(new ReadPoolSaturatedError())).toBe(503);
    expect(readPoolErrorStatus(new ReadPoolTimeoutError())).toBe(503);
    // A structurally-similar error from another module still maps, so a router
    // catching across a package boundary does the right thing.
    const foreign = Object.assign(new Error("saturated"), { code: "read_pool_saturated" });
    expect(readPoolErrorStatus(foreign)).toBe(503);
  });

  it("leaves unrelated errors alone", () => {
    expect(readPoolErrorStatus(new Error("boom"))).toBeNull();
    expect(readPoolErrorStatus(new ReadPoolNotSelectError())).toBeNull();
    expect(readPoolErrorStatus(null)).toBeNull();
  });

  it("exposes the plan's constants", () => {
    // The plan pins these numbers; a change should be a deliberate edit here.
    expect(READ_POOL_QUEUE_LIMIT).toBe(64);
  });
});

describe("read pool: SQLite degradation", () => {
  it("reads through the synchronous handle and reports itself as non-Postgres", async () => {
    const db = new Database(":memory:") as unknown as SqlDatabase;
    db.exec("CREATE TABLE probe (id INTEGER NOT NULL, name TEXT)");
    db.run("INSERT INTO probe (id, name) VALUES (?, ?)", 1, "one");
    db.run("INSERT INTO probe (id, name) VALUES (?, ?)", 2, "two");

    const pool = createReadPool({ databaseUrl: "", sqliteDb: db });
    expect(pool).toBeInstanceOf(SqliteReadPool);
    expect(pool.postgres).toBe(false);

    const rows = await pool.query<{ id: number; name: string }>("SELECT id, name FROM probe ORDER BY id");
    expect(rows).toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ]);
    expect(await pool.queryOne<{ name: string }>("SELECT name FROM probe WHERE id = ?", [2])).toEqual({
      name: "two",
    });
    expect(await pool.queryOne("SELECT name FROM probe WHERE id = ?", [99])).toBeNull();

    // Placeholders are the sqlite dialect, and the pool must not translate
    // them on this arm.
    expect(
      await pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM probe WHERE name IN (?, ?)", ["one", "two"]),
    ).toEqual([{ n: 2 }]);

    await pool.close();
  });

  it("still refuses writes", async () => {
    const db = new Database(":memory:") as unknown as SqlDatabase;
    db.exec("CREATE TABLE probe (id INTEGER NOT NULL)");
    const pool = createReadPool({ databaseUrl: "", sqliteDb: db });
    await expect(pool.query("INSERT INTO probe (id) VALUES (1)")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
    // The refusal is real: nothing was written.
    expect((db.query("SELECT COUNT(*) AS n FROM probe").get() as { n: number }).n).toBe(0);
    await pool.close();
  });

  it("requires a handle when no Postgres URL is configured", () => {
    expect(() => createReadPool({ databaseUrl: "" })).toThrow(/needs a sqlite database/u);
  });

  it("picks the Postgres arm from the URL without connecting", async () => {
    // Constructing must not open a connection: the pool is created at startup,
    // before the database may be reachable.
    const pool = createReadPool({ databaseUrl: "postgres://user:pass@127.0.0.1:1/none" });
    expect(pool).toBeInstanceOf(PostgresReadPool);
    expect(pool.postgres).toBe(true);
    await pool.close();
  });
});

describe.skipIf(!pgAvailable)("read pool: Postgres", () => {
  let pool: PostgresReadPool;
  let url = "";

  function makePool(target: string = url): PostgresReadPool {
    return new PostgresReadPool(target);
  }

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const parsed = new URL(PG_ADMIN_URL);
    parsed.pathname = `/${TEST_DB}`;
    url = parsed.toString();

    // A table for the write-refusal probe. Created through a direct connection,
    // not the pool, because the pool cannot write by design.
    const setup = new Bun.SQL(url, { max: 1 });
    await setup.unsafe("CREATE TABLE mul439_probe (id INTEGER NOT NULL, name TEXT)");
    await setup.end();
  });

  afterAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  it("runs a read and translates the sqlite dialect", async () => {
    pool = makePool();
    const rows = await pool.query<{ answer: number }>("SELECT ? AS answer", [42]);
    expect(rows).toEqual([{ answer: 42 }]);
    // The `?` became `$1`: an untranslated statement would be a syntax error.
    const two = await pool.query<{ a: number; b: number }>("SELECT ? AS a, ? AS b", [1, 2]);
    expect(two).toEqual([{ a: 1, b: 2 }]);
    await pool.close();
  });

  it("refuses a write at the connection, not just in the gate", async () => {
    pool = makePool();
    // Bypass the gate to prove the session itself is read-only: a statement
    // that slipped past the gate still cannot write.
    await expect(pool.query("INSERT INTO multiremi_tasks (id) VALUES ('x')")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
    const direct = await (pool as unknown as { sql: Bun.SQL }).sql
      .unsafe("INSERT INTO mul439_probe (id, name) VALUES (1, 'probe')")
      .then(
      () => "wrote",
      (error: Error) => error.message,
    );
    expect(direct).toContain("read-only transaction");
    await pool.close();
  });

  it("aborts a statement that outlives the client timeout", async () => {
    pool = makePool();
    const started = performance.now();
    await expect(
      pool.query("SELECT pg_sleep(5)", [], { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ReadPoolTimeoutError);
    const elapsed = performance.now() - started;
    // The abort has to fire near its own deadline, not after pg_sleep returns.
    expect(elapsed).toBeLessThan(3_000);
    await pool.close();
  });

  it("cuts a slow statement at the server-side statement_timeout", async () => {
    // 2 s is the configured ceiling; the client abort sits above it so the
    // server-side error is the one that surfaces for a real slow query.
    pool = makePool();
    const started = performance.now();
    await expect(pool.query("SELECT pg_sleep(10)")).rejects.toThrow(/statement timeout|timed out/u);
    expect(performance.now() - started).toBeLessThan(6_000);
    await pool.close();
  });

  it("fails fast with read_pool_saturated once the queue is full, and 503 maps from it", async () => {
    pool = makePool();
    // Occupy all four connections with statements that outlive the test's
    // setup, then fill the queue to its limit.
    const occupiers = Array.from({ length: 4 }, () =>
      pool.query("SELECT pg_sleep(3)", [], { timeoutMs: 10_000 }).catch(() => null),
    );
    // Let the four acquire their slots before the queue is measured.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => pool.active === 4, 2_000);

    const queued = Array.from({ length: READ_POOL_QUEUE_LIMIT }, () =>
      pool.query("SELECT 1", [], { timeoutMs: 10_000 }).catch((error) => error),
    );
    await waitFor(() => pool.queued === READ_POOL_QUEUE_LIMIT, 2_000);

    const started = performance.now();
    const error = await pool.query("SELECT 1").then(
      () => null,
      (caught: unknown) => caught,
    );
    const elapsed = performance.now() - started;

    expect(error).toBeInstanceOf(ReadPoolSaturatedError);
    expect((error as ReadPoolSaturatedError).code).toBe("read_pool_saturated");
    expect(readPoolErrorStatus(error)).toBe(503);
    // The point of failing fast is that it does not wait for a slot.
    expect(elapsed).toBeLessThan(500);

    await Promise.all([...occupiers, ...queued]);
    await pool.close();
  }, 30_000);

  it("recovers after a slow statement that stays inside the server timeout", async () => {
    // Below `statement_timeout` on purpose: this checks the pool releases its
    // slot, not that the timeout fires (the case above covers that).
    pool = makePool();
    await expect(pool.query("SELECT pg_sleep(0.4)", [], { timeoutMs: 10_000 })).resolves.toBeDefined();
    await expect(pool.query("SELECT 1 AS ok")).resolves.toEqual([{ ok: 1 }]);
    expect(pool.active).toBe(0);
    expect(pool.queued).toBe(0);
    await pool.close();
  }, 30_000);

  it("keeps running the queue after a queued caller times out", async () => {
    pool = makePool();
    const blocker = pool.query("SELECT pg_sleep(1)", [], { timeoutMs: 10_000 }).catch(() => null);
    await waitFor(() => pool.active === 1, 2_000);
    // Queue behind the blocker with a deadline that expires while waiting.
    const impatient = pool.query("SELECT 1", [], { timeoutMs: 100 }).catch((error) => error);
    const patient = pool.query("SELECT 2 AS ok", [], { timeoutMs: 10_000 });
    await Promise.all([blocker]);
    await expect(patient).resolves.toEqual([{ ok: 2 }]);
    // Whether `impatient` timed out or got a slot first, it must not have
    // wedged the pool.
    await impatient;
    await expect(pool.query("SELECT 3 AS ok")).resolves.toEqual([{ ok: 3 }]);
    await pool.close();
  }, 30_000);

  it("rejects after close instead of hanging", async () => {
    const closing = makePool();
    await closing.close();
    await expect(closing.query("SELECT 1")).rejects.toThrow(/closed/u);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
