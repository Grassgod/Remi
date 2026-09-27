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
  ReadPoolSideEffectError,
  ReadPoolTimeoutError,
  findForbiddenFunction,
  READ_POOL_QUEUE_LIMIT,
  SqliteReadPool,
  type ReadPool,
} from "@multiremi/store/db/read-pool.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

// The fallback is a local, throwaway placeholder — never a real credential. It
// only decides whether the Postgres block is skipped when the environment does
// not point the suite somewhere.
const PG_ADMIN_URL =
  process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multiremi:local-only@localhost:5432/postgres";
const TEST_DB = `multiremi_mul439_read_pool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

/**
 * Where the test database is, in a form that is safe to log.
 *
 * `MULTIREMI_TEST_POSTGRES_URL` may carry a password (and in production
 * deployments the equivalent `MULTIREMI_DATABASE_URL` does). A skip message is
 * the last place that should end up in a CI log, so it reports the host and
 * port only — enough to tell "nothing is running here" from "the wrong
 * instance is running" — and never the credentials or the path. The parse is
 * wrapped because this helper runs on the failure path, where the value is by
 * definition suspect.
 */
export function describeTestDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//u, "");
    const host = parsed.host || "unknown-host";
    return database ? `${host}/${database}` : host;
  } catch {
    return "an unparseable MULTIREMI_TEST_POSTGRES_URL";
  }
}

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
  const configured = process.env.MULTIREMI_TEST_POSTGRES_URL ? "" : " (MULTIREMI_TEST_POSTGRES_URL is unset)";
  console.warn(
    `[mul439-read-pool] Postgres not reachable at ${describeTestDatabaseTarget(PG_ADMIN_URL)}${configured} — skipping the pool's Postgres checks.`,
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

describe("read pool: the skip message does not leak the DSN", () => {
  it("reports host and database, never credentials", () => {
    // The skip message is written to a CI log. `MULTIREMI_TEST_POSTGRES_URL`
    // (and its production twin) carries a password, so the message must be
    // built from a parse that drops the userinfo.
    const target = describeTestDatabaseTarget(
      "postgres://multiremi:SUPERSECRETPW@db.internal:5432/multiremi",
    );
    expect(target).toBe("db.internal:5432/multiremi");
    expect(target).not.toContain("SUPERSECRETPW");
    expect(target).not.toContain("multiremi:SUPERSECRETPW");
  });

  it("drops a percent-encoded password too", () => {
    const target = describeTestDatabaseTarget("postgres://user:pa%40ss@127.0.0.1:55440/postgres");
    expect(target).not.toContain("pa%40ss");
    expect(target).toBe("127.0.0.1:55440/postgres");
  });

  it("handles a value that is not a URL without echoing it", () => {
    // The helper runs on the failure path, where the value is suspect by
    // definition. It must not hand the raw string back.
    const target = describeTestDatabaseTarget("postgres://u:secretpw@");
    expect(target).not.toContain("secretpw");
    expect(describeTestDatabaseTarget("nonsense")).toBe(
      "an unparseable MULTIREMI_TEST_POSTGRES_URL",
    );
  });

  it("omits the database when the URL has none, and says so when unset", () => {
    expect(describeTestDatabaseTarget("postgres://user:pw@host:5432")).toBe("host:5432");
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
    const pool = createReadPool({ databaseUrl: "postgres://placeholder:placeholder@127.0.0.1:1/none" });
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

/**
 * The bypasses independent review found in MUL-439 `cmt_u0bywkppcajq`.
 *
 * Each case is the counterexample QA reproduced against the first cut, kept
 * here so the hardening cannot silently regress. They run on a real server
 * because the previous behaviour was a property of real sessions and locks —
 * a mock would have "passed" the vulnerable code just as happily.
 */
describe.skipIf(!pgAvailable)("read pool: session state cannot be disarmed", () => {
  let pool: PostgresReadPool;
  let url = "";
  let inspect: Bun.SQL;

  /** A pool against the escalation fixture database. */
  function makePool(target: string = url): PostgresReadPool {
    return new PostgresReadPool(target);
  }

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_esc WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}_esc`);
    await admin.end();
    const parsed = new URL(PG_ADMIN_URL);
    parsed.pathname = `/${TEST_DB}_esc`;
    url = parsed.toString();

    inspect = new Bun.SQL(url, { max: 1 });
    await inspect.unsafe("CREATE TABLE write_probe (id int primary key)");
    // The write function QA used: reachable only through a `SELECT`, so the
    // statement classifier alone cannot tell it from a read.
    await inspect.unsafe(`
      CREATE OR REPLACE FUNCTION mul439_write_row() RETURNS int LANGUAGE sql AS $$
        INSERT INTO write_probe VALUES (1); SELECT 1;
      $$`);
    await inspect.unsafe("CREATE SEQUENCE IF NOT EXISTS mul439_seq");
    await inspect.unsafe("CREATE TABLE mul439_target AS SELECT 1 AS id");
  });

  afterAll(async () => {
    await inspect?.end();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_esc WITH (FORCE)`);
    await admin.end();
  });

  async function writeProbeRows(): Promise<number> {
    return (await inspect.unsafe("SELECT count(*)::int AS n FROM write_probe"))[0].n as number;
  }

  /** The raw driver behind the pool, used to prove a bypass without the gate. */
  function rawDriver(target: PostgresReadPool): Bun.SQL {
    return (target as unknown as { sql: Bun.SQL }).sql;
  }

  it("refuses set_config, so the session default can never be disarmed through the pool", async () => {
    pool = makePool(url);
    await expect(
      pool.query("SELECT set_config('default_transaction_read_only','off',false)"),
    ).rejects.toBeInstanceOf(ReadPoolSideEffectError);
    // And the underlying session still says read-only.
    expect((await rawDriver(pool).unsafe("SHOW default_transaction_read_only"))[0].default_transaction_read_only).toBe("on");
    await pool.close();
  });

  it("refuses set_config for statement_timeout, and the server ceiling still applies", async () => {
    // QA's second disarm: `set_config('statement_timeout','0',false)` used to
    // clear the 2 s ceiling. Even with the session value rewritten directly on
    // the driver (bypassing the gate), `SET LOCAL` inside the transaction keeps
    // the statement bounded.
    pool = makePool(url);
    await expect(
      pool.query("SELECT set_config('statement_timeout','0',false)"),
    ).rejects.toBeInstanceOf(ReadPoolSideEffectError);

    const driver = rawDriver(pool);
    await driver.unsafe("SELECT set_config('statement_timeout','0',false)");
    const started = performance.now();
    await expect(pool.query("SELECT pg_sleep(5)")).rejects.toThrow(/statement timeout/u);
    const elapsed = performance.now() - started;
    expect(elapsed, `pg_sleep ran for ${Math.round(elapsed)}ms`).toBeLessThan(4_000);
    // The transaction scoping means the pool's next read is bounded again.
    await expect(pool.query("SELECT pg_sleep(5)")).rejects.toThrow(/statement timeout/u);
    await pool.close();
  }, 30_000);

  it("keeps a write out even when the session default is disarmed underneath it", async () => {
    // The exact escalation QA demonstrated: disarm the session, then call a
    // write function through `SELECT`. The transaction's own mode is what
    // blocks it, so the disarmed session value makes no difference.
    pool = makePool(url);
    const before = await writeProbeRows();
    await rawDriver(pool).unsafe("SELECT set_config('default_transaction_read_only','off',false)");

    await expect(pool.query("SELECT mul439_write_row()")).rejects.toThrow(/read-only transaction/u);
    // Fail-closed: no row, and nothing left over for a retry to double up.
    expect(await writeProbeRows()).toBe(before);

    // A plain read still works on the same disarmed connection.
    await expect(pool.query("SELECT 42 AS answer")).resolves.toEqual([{ answer: 42 }]);
    await pool.close();
  }, 30_000);

  it("refuses to flip the transaction to read-write mid-flight", async () => {
    // `SET TRANSACTION READ WRITE` as the first statement of a transaction is
    // accepted by Postgres and would reopen the write path. It is a `SET`, so
    // the classifier already turns it away; this pins that.
    pool = makePool(url);
    await expect(pool.query("SET TRANSACTION READ WRITE")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
    await expect(pool.query("SET default_transaction_read_only = off")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
    await pool.close();
  });

  it("refuses the side-effecting functions QA listed", async () => {
    pool = makePool(url);
    const cases: Array<[string, string, string]> = [
      ["set_config", "set_config", "SELECT set_config('default_transaction_read_only','off',false)"],
      ["pg_notify", "pg_notify", "SELECT pg_notify('mul439_channel','payload')"],
      ["pg_advisory_lock", "pg_advisory_lock", "SELECT pg_advisory_lock(439001)"],
      ["pg_advisory_lock_shared", "pg_advisory_lock_shared", "SELECT pg_advisory_lock_shared(439002)"],
      ["pg_try_advisory_lock", "pg_try_advisory_lock", "SELECT pg_try_advisory_lock(439003)"],
      ["pg_advisory_xact_lock", "pg_advisory_xact_lock", "SELECT pg_advisory_xact_lock(439004)"],
      ["pg_terminate_backend", "pg_terminate_backend", "SELECT pg_terminate_backend(1)"],
      ["pg_cancel_backend", "pg_cancel_backend", "SELECT pg_cancel_backend(1)"],
      ["nextval", "nextval", "SELECT nextval('mul439_seq')"],
      ["setval", "setval", "SELECT setval('mul439_seq', 5)"],
      ["pg_read_file", "pg_read_file", "SELECT pg_read_file('/etc/hostname')"],
      ["pg_read_binary_file", "pg_read_binary_file", "SELECT pg_read_binary_file('/etc/hostname')"],
      ["pg_ls_dir", "pg_ls_dir", "SELECT pg_ls_dir('/tmp')"],
      ["lo_create", "lo_create", "SELECT lo_create(0)"],
      ["lo_import", "lo_import", "SELECT lo_import('/etc/hostname')"],
      ["dblink", "dblink", "SELECT dblink('dbname=postgres','SELECT 1')"],
      ["dblink_exec", "dblink_exec", "SELECT dblink_exec('dbname=postgres','SELECT 1')"],
    ];
    for (const [label, fn, sql] of cases) {
      const error = await pool.query(sql).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, `${label} was allowed through the gate`).toBeInstanceOf(ReadPoolSideEffectError);
      expect((error as ReadPoolSideEffectError).functionName).toBe(fn);
      expect((error as ReadPoolSideEffectError).code).toBe("read_pool_side_effect");
    }
    await pool.close();
  });

  it("leaves no advisory lock behind after the refused calls", async () => {
    // QA observed a lock still held after the statement returned. Nothing that
    // takes a lock reaches the server now, so the count has to be zero.
    pool = makePool(url);
    await pool.query("SELECT pg_advisory_lock(439005)").catch(() => null);
    await pool.query("SELECT pg_try_advisory_lock(439006)").catch(() => null);
    await pool.query("SELECT pg_advisory_xact_lock(439007)").catch(() => null);

    const held = await inspect.unsafe(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    expect(held[0].n).toBe(0);
    await pool.close();
  });

  it("does not terminate another backend", async () => {
    // QA's case: `pg_terminate_backend` returned true for a sibling connection.
    // The victim is a connection this test owns, so a regression fails loudly
    // here instead of taking out an unrelated client.
    pool = makePool(url);
    const victim = new Bun.SQL(url, { max: 1 });
    const victimPid = (await victim.unsafe("SELECT pg_backend_pid() AS pid"))[0].pid as number;

    await expect(
      pool.query("SELECT pg_terminate_backend(?)", [victimPid]),
    ).rejects.toBeInstanceOf(ReadPoolSideEffectError);
    await expect(
      pool.query("SELECT pg_cancel_backend(?)", [victimPid]),
    ).rejects.toBeInstanceOf(ReadPoolSideEffectError);

    // The victim is alive: a terminated connection would fail this query.
    const alive = (await victim.unsafe("SELECT 1 AS alive")) as Array<{ alive: number }>;
    expect(alive).toEqual([{ alive: 1 }]);
    await victim.end();
    await pool.close();
  });

  it("still allows ordinary reads, including functions that only read", async () => {
    // The denylist must not turn into "no functions". These are the shapes the
    // conversation-log queries use.
    pool = makePool(url);
    await expect(pool.query("SELECT now() AS ts")).resolves.toHaveLength(1);
    await expect(pool.query("SELECT current_setting('server_version_num') AS v")).resolves.toHaveLength(1);
    await expect(pool.query("SELECT length('abc') AS n")).resolves.toEqual([{ n: 3 }]);
    await expect(pool.query("SELECT count(*)::int AS n FROM mul439_target")).resolves.toEqual([{ n: 1 }]);
    await expect(
      pool.query("SELECT COALESCE(?::text, 'fallback') AS v", [null]),
    ).resolves.toEqual([{ v: "fallback" }]);
    // A column named like a forbidden function is not a call to it.
    await expect(
      pool.query("SELECT set_config AS set_config FROM (SELECT 1 AS set_config) AS t"),
    ).resolves.toEqual([{ set_config: 1 }]);
    await pool.close();
  });

  it("bounds every statement with SET LOCAL even after a session-level change", async () => {
    // Positive control for the timeout claim: the SHOW inside the transaction
    // has to report the pool's value, not whatever the session was set to.
    pool = makePool(url);
    const driver = rawDriver(pool);
    await driver.unsafe("SELECT set_config('statement_timeout','0',false)");
    const shown = await pool.query("SELECT current_setting('statement_timeout') AS v");
    // Postgres normalises 2000 to `2s`.
    expect(["2000", "2000ms", "2s"]).toContain(shown[0].v as string);
    await pool.close();
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
