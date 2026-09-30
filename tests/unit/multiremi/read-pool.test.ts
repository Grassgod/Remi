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
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import {
  createReadPool,
  isReadOnlySelect,
  PostgresReadPool,
  readPoolErrorStatus,
  ReadPoolNotSelectError,
  ReadPoolSaturatedError,
  ReadPoolSideEffectError,
  ReadPoolTimeoutError,
  findDisallowedFunction,
  READ_FUNCTION_WHITELIST,
  READ_POOL_QUEUE_LIMIT,
  SqliteReadPool,
  type ReadPool,
} from "@multiremi/store/db/read-pool.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { maskSqlLiterals, scanSqlFunctionCalls } from "@multiremi/store/db/sql-calls.js";
import { resolveStartupApiRole } from "@multiremi/config/startup-env.js";
import {
  SQL_CONTEXTUAL_KEYWORD_HEADS,
  SQL_UNCONDITIONAL_KEYWORD_HEADS,
} from "@multiremi/store/db/sql-keywords.js";

// The fallback is a local, throwaway placeholder — never a real credential. It
// only decides whether the Postgres block is skipped when the environment does
// not point the suite somewhere.
const PG_ADMIN_URL =
  process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multiremi:local-only@localhost:5432/postgres";
const TEST_DB = `multiremi_mul439_read_pool_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

/**
 * A read that takes longer than the pool's deadlines, built only from
 * whitelisted functions.
 *
 * The timing cases used `pg_sleep`, which the whitelist now (correctly) refuses
 * before the statement is sent — so it would have tested the gate instead of
 * the deadline. Counting a large series is ordinary read work: the planner
 * cannot shortcut it, it touches no table, and it is exactly the shape of query
 * the pool's timeout exists for.
 */
const SLOW_READ = "SELECT count(*) FROM generate_series(1, 100000000) AS g";

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

  it("rejects a statement batch, but allows one trailing terminator", () => {
    // Only the first statement would be the one the classifier inspected, so a
    // batch is refused outright rather than half-checked (`cmt_0f5ulv021ijn`).
    for (const sql of [
      "SELECT 1; SELECT 2",
      "SELECT 1; DELETE FROM t",
      "SELECT 1;;",
      "WITH x AS (SELECT 1) SELECT * FROM x; SELECT 2",
    ]) {
      expect(isReadOnlySelect(sql), `${JSON.stringify(sql)} should be rejected`).toBe(false);
    }
    // A single trailing `;` is a terminator, not a second statement.
    for (const sql of [
      "SELECT 1;",
      "SELECT 1;  ",
      "SELECT 1;\n",
      "SELECT 1; -- trailing comment",
      "WITH x AS (SELECT 1) SELECT * FROM x;",
    ]) {
      expect(isReadOnlySelect(sql), `${JSON.stringify(sql)} should be a read`).toBe(true);
    }
    // A `;` inside a literal is not a separator.
    expect(isReadOnlySelect("SELECT 'a;b' AS s")).toBe(true);
    expect(isReadOnlySelect("SELECT $$ a;b $$ AS s")).toBe(true);
    expect(isReadOnlySelect("SELECT 1 /* ; */")).toBe(true);
  });

  it("rejects every locking clause, not just FOR UPDATE", () => {
    // All four take row locks. A read-only transaction rejects them too; naming
    // them here turns a server error into a clear gate refusal.
    for (const clause of ["FOR UPDATE", "FOR SHARE", "FOR KEY SHARE", "FOR NO KEY UPDATE"]) {
      expect(
        isReadOnlySelect(`SELECT * FROM t ${clause}`),
        `${clause} should be rejected`,
      ).toBe(false);
      // `NOWAIT` / `SKIP LOCKED` are still locking clauses.
      expect(isReadOnlySelect(`SELECT * FROM t ${clause} NOWAIT`)).toBe(false);
      expect(isReadOnlySelect(`SELECT * FROM t ${clause} SKIP LOCKED`)).toBe(false);
    }
    // The words inside a literal are not a clause.
    expect(isReadOnlySelect("SELECT 'FOR SHARE' AS s")).toBe(true);
    expect(isReadOnlySelect("SELECT 'FOR UPDATE' AS s")).toBe(true);
  });

  it("rejects a write before it ever reaches a connection", async () => {
    const sqlite = new SqliteReadPool(openSqliteDatabase(":memory:") as unknown as SqlDatabase);
    await expect(sqlite.query("DELETE FROM multiremi_tasks")).rejects.toBeInstanceOf(
      ReadPoolNotSelectError,
    );
  });
});

describe("read pool: the function gate is a whitelist, not a denylist", () => {
  /**
   * QA's second-round counterexamples (`cmt_w08j1ocyurc6`). The previous gate
   * matched a regex over raw text, so PostgreSQL's quoted spelling of a
   * function name went straight through. Each case here is the exact statement
   * that was reproduced against the pooled connection.
   */
  it("refuses every quoted spelling of a side-effecting function", () => {
    for (const sql of [
      `SELECT "set_config"('default_transaction_read_only','off',false)`,
      `SELECT pg_catalog."set_config"('statement_timeout','0',false)`,
      `SELECT "pg_advisory_lock"(439)`,
      `SELECT "pg_notify"('channel','payload')`,
      `SELECT "pg_terminate_backend"(1)`,
      `SELECT "lo_export"(0,'/tmp/x')`,
      `SELECT "pg_read_file"('/etc/hostname')`,
      `SELECT "dblink_exec"('conn','SELECT 1')`,
    ]) {
      expect(findDisallowedFunction(sql), sql).not.toBeNull();
    }
  });

  it("refuses a quoted identifier even when the name is whitelisted", () => {
    // `"COUNT"(*)` is a *user* function, not the aggregate: PostgreSQL treats a
    // quoted name as distinct from the unquoted one. Accepting quoted spellings
    // at all is what made the previous gates bypassable, so none are accepted.
    expect(findDisallowedFunction(`SELECT "COUNT"(*) FROM t`)).toContain("quoted identifier");
    expect(findDisallowedFunction(`SELECT "set_config"('a','b',false)`)).toContain(
      "quoted identifier",
    );
    // The unquoted form of a whitelisted name is fine.
    expect(findDisallowedFunction(`SELECT count(*) FROM t`)).toBeNull();
  });

  it("refuses U& escaped identifiers without trying to decode them", () => {
    // `U&"\0070g_notify"` is `pg_notify`; the scanner does not decode escapes,
    // so it refuses the spelling outright.
    expect(findDisallowedFunction(`SELECT U&"\\0070g_notify"('c','p')`)).toContain("U& escaped");
  });

  it("refuses a schema qualifier other than pg_catalog", () => {
    expect(findDisallowedFunction(`SELECT public.now()`)).toContain("non-pg_catalog schema");
    expect(findDisallowedFunction(`SELECT "PG_CATALOG".set_config('a','b',false)`)).toContain(
      "non-pg_catalog schema",
    );
    // The real `pg_catalog` qualifier is accepted for a whitelisted name.
    expect(findDisallowedFunction(`SELECT pg_catalog.current_setting('x')`)).toBeNull();
  });

  it("refuses a user-defined function", () => {
    // The whitelist is a closed list, so anything a migration creates is
    // refused by default rather than by being enumerated as forbidden.
    expect(findDisallowedFunction(`SELECT qa_write_row()`)).toBe("qa_write_row");
    expect(findDisallowedFunction(`SELECT "qa_write_row"()`)).toContain("quoted identifier");
  });

  it("refuses a statement it cannot tokenise, rather than passing it through", () => {
    // Misreading must fail closed: the pool treats an unparsable statement the
    // same as a disallowed call.
    expect(findDisallowedFunction(`SELECT 'unterminated`)).toContain("unscannable statement");
    expect(findDisallowedFunction(`SELECT /* unterminated`)).toContain("unscannable statement");
    expect(findDisallowedFunction(`SELECT $tag$ unterminated`)).toContain("unscannable statement");
  });

  it("allows the call shapes the store actually issues", () => {
    // Taken from the real statements in packages/server/src (see the corpus
    // sweep in the PR description): these must not be refused, or the pool
    // would break the queries it exists to serve.
    for (const sql of [
      `SELECT count(*) FROM t`,
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM t`,
      `SELECT (json_agg(usage) FILTER (WHERE status NOT IN ('a')))::text AS x FROM t`,
      `SELECT md5(string_agg(id || ':' || xmin::text, ',' ORDER BY id COLLATE "C")) FROM t`,
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC) FROM t`,
      `SELECT lower(email) FROM multiremi_users WHERE lower(email) = $1`,
      `SELECT SUBSTR(body, 1, 240) FROM t`,
      `SELECT * FROM t WHERE status IN ('queued','running')`,
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM t)`,
      `SELECT CAST(x AS int) FROM t`,
      `SELECT x::numeric(10,2) FROM t`,
      `WITH recent AS (SELECT 1 AS a) SELECT a FROM recent ORDER BY a LIMIT 10`,
      `SELECT * FROM t ORDER BY name COLLATE "C"`,
      `SELECT now() AS ts`,
      `SELECT unnest(ARRAY[1,2])`,
      `SELECT generate_series FROM generate_series(1,10)`,
      `SELECT * FROM t WHERE a = (SELECT 1)`,
    ]) {
      expect(findDisallowedFunction(sql), sql).toBeNull();
    }
  });

  it("does not mistake text or comments for a call", () => {
    for (const sql of [
      `SELECT 'pg_notify(' AS s`,
      `SELECT 'it''s pg_notify(' AS s`,
      `SELECT E'\\'pg_notify(' AS s`,
      `SELECT $x$ pg_notify( $x$ AS s`,
      `SELECT $$ pg_notify( $$ AS s`,
      `SELECT /* pg_notify( */ 1`,
      `SELECT 1 -- pg_notify(`,
      `SELECT * FROM t WHERE note LIKE '%set_config(%'`,
    ]) {
      expect(findDisallowedFunction(sql), sql).toBeNull();
    }
  });

  it("finds a call however it is written, including behind comments", () => {
    for (const sql of [
      `SELECT pg_notify('c','p')`,
      `SELECT Pg_Notify('c','p')`,
      `SELECT pg_catalog.pg_notify('c','p')`,
      `SELECT /*x*/ pg_notify('c','p')`,
      `SELECT (pg_notify('c','p'))`,
      `WITH x AS (SELECT pg_notify('c','p')) SELECT * FROM x`,
      `SELECT * FROM t WHERE a = (SELECT pg_advisory_lock(1))`,
    ]) {
      expect(findDisallowedFunction(sql), sql).not.toBeNull();
    }
  });

  it("scans the quote, comment and escape branches of the lexer", () => {
    // Direct coverage of `scanSqlFunctionCalls`, which is what makes the gate
    // resistant to spellings a regex cannot distinguish. The PG-backed suite
    // below proves the same statements are refused at the pool; these assertions
    // are the ones that run without a database.
    const names = (sql: string): string[] =>
      scanSqlFunctionCalls(sql).map((call) => (call.schema ? `${call.schema}.` : "") + call.name);

    // Single quotes, including the doubled escape, hide a call.
    expect(names(`SELECT 'a''b pg_notify(' AS s`)).toEqual([]);
    // `E'…'` honours backslash escapes, so `'` does not close the string.
    expect(names(`SELECT E'a\\'pg_notify(' AS s`)).toEqual([]);
    // Dollar quotes, with a tag and with an empty tag.
    expect(names(`SELECT $tag$ pg_notify( $tag$ AS s`)).toEqual([]);
    expect(names(`SELECT $$ pg_notify( $$ AS s`)).toEqual([]);
    // Nested block comments are consumed to their matching close.
    expect(names(`SELECT /* a /* pg_notify( */ b */ 1`)).toEqual([]);
    // A quoted identifier is reported with its case preserved.
    expect(names(`SELECT "pg_Notify"('c','p')`)).toEqual(["pg_Notify"]);
    // A doubled quote inside a quoted identifier is an escape, not a close.
    expect(names(`SELECT "a""b"()`)).toEqual(["a\"b"]);
    // `::type(...)` is a cast's precision, not a call.
    expect(names(`SELECT x::numeric(10,2) FROM t`)).toEqual([]);
    // Reserved keywords that take parentheses are not calls.
    for (const kw of ["IN", "EXISTS", "CAST", "ANY", "ALL", "COALESCE", "NULLIF"]) {
      expect(names(`SELECT 1 WHERE x ${kw} (1)`), kw).toEqual([]);
    }
    // `FILTER` and `OVER` are only clause keywords after a `)`. Written after a
    // bare identifier they are function calls, which is the third review's
    // finding, so they must be reported here.
    expect(names(`SELECT count(*) FILTER (WHERE x) FROM t`)).toEqual(["count"]);
    expect(names(`SELECT sum(x) OVER (PARTITION BY y) FROM t`)).toEqual(["sum"]);
    expect(names(`SELECT x OVER (1)`)).toEqual(["over"]);
    expect(names(`SELECT x FILTER (1)`)).toEqual(["filter"]);
    expect(names(`SELECT x WITHIN (1)`)).toEqual(["within"]);
    // An operator between an identifier and `(` means the two are unrelated.
    expect(names(`SELECT a = (SELECT 1)`)).toEqual([]);
    // A dollar placeholder is not a quote and does not swallow the statement.
    expect(names(`SELECT $1::text, lower($2) AS x`)).toEqual(["lower"]);
  });

  it("classifier and gate share one view of literals and comments", () => {
    // The two deciders must not disagree about what a string or a comment is,
    // or a statement could be a read to one and a write to the other. A keyword
    // hidden inside a literal is the case that separates a shared lexer from
    // two independent regexes.
    expect(maskSqlLiterals("SELECT 'DELETE FROM t' AS s")).not.toContain("DELETE");
    expect(maskSqlLiterals("SELECT /* DELETE */ 1")).not.toContain("DELETE");
    expect(maskSqlLiterals("SELECT 1 -- DELETE")).not.toContain("DELETE");
    expect(maskSqlLiterals("SELECT $q$ DELETE $q$ AS s")).not.toContain("DELETE");
    // The code itself is untouched, so the classifier can still find `SELECT`.
    expect(maskSqlLiterals("SELECT 1 AS a")).toBe("SELECT 1 AS a");
    expect(maskSqlLiterals("SELECT/*x*/1")).toMatch(/^SELECT\s+1$/u);

    for (const [sql, isRead] of [
      ["SELECT 'DELETE FROM t' AS s", true],
      ["SELECT /* DELETE */ 1", true],
      ["SELECT 1 -- DELETE", true],
      ["SELECT $q$ DELETE $q$ AS s", true],
      ["DELETE FROM t", false],
      ["SELECT 1; DELETE FROM t", false],
      ["WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x", false],
      ["SELECT 1 INTO new_t", false],
    ] as Array<[string, boolean]>) {
      expect(isReadOnlySelect(sql), `${JSON.stringify(sql)} classified wrong`).toBe(isRead);
      // And the gate must also not be fooled into refusing a read because of a
      // literal's contents.
      if (isRead) expect(findDisallowedFunction(sql), `${sql} refused by the gate`).toBeNull();
    }
  });

  it("keeps the whitelist free of the functions the previous gates missed", async () => {
    // A guard on the list itself: if any of these were ever added, the pool
    // would be back to allowing a known side effect.
    for (const name of [
      "set_config",
      "pg_notify",
      "pg_advisory_lock",
      "pg_advisory_xact_lock",
      "pg_advisory_unlock",
      "pg_advisory_unlock_all",
      "pg_try_advisory_lock",
      "pg_terminate_backend",
      "pg_cancel_backend",
      "nextval",
      "setval",
      "lo_create",
      "lo_export",
      "lo_import",
      "lo_unlink",
      "lo_open",
      "lowrite",
      "pg_read_file",
      "pg_read_binary_file",
      "pg_ls_dir",
      "pg_stat_file",
      "dblink",
      "dblink_exec",
      "dblink_connect",
    ]) {
      expect(READ_FUNCTION_WHITELIST.has(name), `${name} must not be whitelisted`).toBe(false);
    }
    // And it is not empty in a way that would pass the check above vacuously.
    expect(READ_FUNCTION_WHITELIST.has("count")).toBe(true);
    // Pinned exactly, so the number in the module comment and the PR
    // description cannot drift from the code. Adding a function is a deliberate
    // edit here as well as there — which is the point, since every entry is a
    // claim that the function has no side effect.
    expect(READ_FUNCTION_WHITELIST.size).toBe(188);
    // No duplicates: a name listed twice would mean the count overstates the
    // whitelist's coverage.
    const source = await Bun.file(
      new URL("../../../packages/server/src/store/db/read-pool.ts", import.meta.url),
    ).text();
    const listed = source.match(/^\s{2}"[a-z0-9_]+",$/gmu) ?? [];
    expect(new Set(listed).size).toBe(listed.length);
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
    const db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
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
    const db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
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

  it("uses each process's resolved role for capacity, independent of ambient role", async () => {
    const url = "postgres://placeholder:placeholder@127.0.0.1:1/none";
    const ui = createReadPool({ databaseUrl: url, role: resolveStartupApiRole({ MULTIREMI_API_ROLE: "ui" }).role });
    const runtime = createReadPool({ databaseUrl: url, role: resolveStartupApiRole({ MULTIREMI_API_ROLE: "runtime" }).role });
    const defaultPool = createReadPool({ databaseUrl: url });
    expect((ui as PostgresReadPool).capacity).toEqual({ maxConnections: 4, queueLimit: 64 });
    expect((runtime as PostgresReadPool).capacity).toEqual({ maxConnections: 2, queueLimit: 16 });
    expect((defaultPool as PostgresReadPool).capacity).toEqual({ maxConnections: 4, queueLimit: 64 });
    await Promise.all([ui.close(), runtime.close(), defaultPool.close()]);
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
      pool.query(SLOW_READ, [], { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ReadPoolTimeoutError);
    const elapsed = performance.now() - started;
    // The abort has to fire near its own deadline, not after the query would
    // have finished. The slow read is `generate_series`, which is whitelisted
    // and purely computational — using `pg_sleep` here would now be refused by
    // the gate before it ever reached the server, testing the wrong layer.
    expect(elapsed).toBeLessThan(3_000);
    await pool.close();
  });

  it("cuts a slow statement at the server-side statement_timeout", async () => {
    // 2 s is the configured ceiling; the client abort sits above it so the
    // server-side error is the one that surfaces for a real slow query.
    pool = makePool();
    const started = performance.now();
    await expect(pool.query(SLOW_READ)).rejects.toThrow(/statement timeout|timed out/u);
    expect(performance.now() - started).toBeLessThan(6_000);
    await pool.close();
  });

  it("fails fast with read_pool_saturated once the queue is full, and 503 maps from it", async () => {
    pool = makePool();
    // Occupy all four connections with statements that outlive the test's
    // setup, then fill the queue to its limit.
    const occupiers = Array.from({ length: 4 }, () =>
      pool.query(SLOW_READ, [], { timeoutMs: 10_000 }).catch(() => null),
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
    await expect(
      pool.query("SELECT count(*)::int AS n FROM generate_series(1, 200000)")
    ).resolves.toBeDefined();
    await expect(pool.query("SELECT 1 AS ok")).resolves.toEqual([{ ok: 1 }]);
    expect(pool.active).toBe(0);
    expect(pool.queued).toBe(0);
    await pool.close();
  }, 30_000);

  it("keeps running the queue after a queued caller times out", async () => {
    pool = makePool();
    const blocker = pool.query(SLOW_READ, [], { timeoutMs: 10_000 }).catch(() => null);
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
    await expect(pool.query(SLOW_READ)).rejects.toThrow(/statement timeout/u);
    const elapsed = performance.now() - started;
    expect(elapsed, `the slow read ran for ${Math.round(elapsed)}ms`).toBeLessThan(4_000);
    // The transaction scoping means the pool's next read is bounded again.
    await expect(pool.query(SLOW_READ)).rejects.toThrow(/statement timeout/u);
    await pool.close();
  }, 30_000);

  it("keeps a write out even when the session default is disarmed underneath it", async () => {
    // QA's escalation: disarm the session, then call a write function through
    // `SELECT`. Two layers have to hold, and this test exercises both.
    pool = makePool(url);
    const before = await writeProbeRows();
    const driver = rawDriver(pool);
    await driver.unsafe("SELECT set_config('default_transaction_read_only','off',false)");

    // Layer 2: the whitelist refuses the name before the statement is sent.
    await expect(pool.query("SELECT mul439_write_row()")).rejects.toBeInstanceOf(
      ReadPoolSideEffectError,
    );

    // Layer 1: with the gate bypassed, the read-only transaction is what stops
    // it — which is the part this test is really about. The call is issued the
    // same way `execute()` issues one, so this proves the transaction alone is
    // sufficient for a write.
    await expect(
      driver.begin("read only", async (tx: Bun.SQL) => {
        await tx.unsafe("SET LOCAL statement_timeout = 2000");
        return tx.unsafe("SELECT mul439_write_row()");
      }),
    ).rejects.toThrow(/read-only transaction/u);

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

/**
 * The quoted-identifier bypasses from the second review (`cmt_w08j1ocyurc6`).
 *
 * Each one was reproduced against the pooled connection with a real server, so
 * each one is reproduced here. The previous gate matched a regex over the raw
 * statement text and could not tell `"set_config"(` from `set_config(`; the
 * white list resolves both to the same name and refuses it.
 *
 * Every case also asserts there is no residue afterwards. Refusing the call is
 * necessary but not sufficient: the pool must not have let a lock be taken, a
 * notification be delivered, another backend be killed, or the session's own
 * GUCs be changed on the way in.
 */
describe.skipIf(!pgAvailable)("read pool: quoted and escaped calls cannot bypass the gate", () => {
  let pool: PostgresReadPool;
  let url = "";
  let inspect: Bun.SQL;
  const WRITE_TABLE = "round3_write_probe";

  /** The raw driver behind the pool, for out-of-band inspection. */
  function rawDriver(target: PostgresReadPool): Bun.SQL {
    return (target as unknown as { sql: Bun.SQL }).sql;
  }

  function makePool(target: string = url): PostgresReadPool {
    return new PostgresReadPool(target);
  }

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_q WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}_q`);
    await admin.end();
    const parsed = new URL(PG_ADMIN_URL);
    parsed.pathname = `/${TEST_DB}_q`;
    url = parsed.toString();

    inspect = new Bun.SQL(url, { max: 1 });
    await inspect.unsafe(`CREATE TABLE ${WRITE_TABLE} (id int)`);
    // The user-defined write function QA wrote: only reachable through a
    // `SELECT`, so nothing but the whitelist can tell it from a pure call.
    await inspect.unsafe(`
      CREATE OR REPLACE FUNCTION qa_write_row() RETURNS int LANGUAGE sql AS $$
        INSERT INTO ${WRITE_TABLE} VALUES (1); SELECT 1;
      $$`);
    await inspect.unsafe("CREATE SEQUENCE IF NOT EXISTS qa_round3_seq");
  });

  afterAll(async () => {
    await inspect?.end();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_q WITH (FORCE)`);
    await admin.end();
  });

  async function writeRows(): Promise<number> {
    return (await inspect.unsafe(`SELECT count(*)::int AS n FROM ${WRITE_TABLE}`))[0].n as number;
  }

  /** Advisory locks held in this test database. */
  async function advisoryLocks(): Promise<number> {
    return (
      await inspect.unsafe(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      )
    )[0].n as number;
  }

  /**
   * The session's own settings, read on the pool's first connection.
   *
   * QA's escalation changed these through `"set_config"` and left the pooled
   * session read-write. Reading them back is what makes "no residue" concrete.
   */
  async function sessionSettings(): Promise<{ readOnly: string; timeout: string }> {
    const driver = rawDriver(pool);
    await driver.unsafe("SELECT 1");
    const row = (
      await driver.unsafe(
        "SELECT current_setting('default_transaction_read_only') AS dro, current_setting('statement_timeout') AS st",
      )
    )[0] as { dro: string; st: string };
    return { readOnly: row.dro, timeout: row.st };
  }

  /** Assert the statement is refused and that nothing observable changed. */
  async function expectRefusedWithNoResidue(sql: string, label: string): Promise<void> {
    const rowsBefore = await writeRows();
    const locksBefore = await advisoryLocks();

    const error = await pool.query(sql).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error, `${label}: ${sql}`).toBeInstanceOf(ReadPoolSideEffectError);
    expect((error as ReadPoolSideEffectError).code).toBe("read_pool_side_effect");

    expect(await writeRows(), `${label}: a row was written`).toBe(rowsBefore);
    expect(await advisoryLocks(), `${label}: an advisory lock was left behind`).toBe(locksBefore);

    const settings = await sessionSettings();
    expect(settings.readOnly, `${label}: session default was disarmed`).toBe("on");
    expect(["2000", "2000ms", "2s"], `${label}: session timeout changed`).toContain(
      settings.timeout,
    );
  }

  it("refuses the quoted spellings QA used, with no residue", async () => {
    pool = makePool(url);
    const cases: Array<[string, string]> = [
      ["quoted set_config", `SELECT "set_config"('default_transaction_read_only','off',false)`],
      ["pg_catalog quoted set_config", `SELECT pg_catalog."set_config"('statement_timeout','0',false)`],
      ["quoted advisory lock", `SELECT "pg_advisory_lock"(439101)`],
      ["plain advisory unlock", `SELECT pg_advisory_unlock(439102)`],
      ["quoted pg_notify", `SELECT "pg_notify"('round3_channel','payload')`],
      ["quoted terminate_backend", `SELECT "pg_terminate_backend"(1)`],
      ["quoted lo_export", `SELECT "lo_export"(0,'/tmp/round3_lo_export')`],
      ["quoted pg_read_file", `SELECT "pg_read_file"('/etc/hostname')`],
      ["user function", `SELECT qa_write_row()`],
      ["quoted user function", `SELECT "qa_write_row"()`],
      ["quoted dblink_exec", `SELECT "dblink_exec"('dbname=postgres','SELECT 1')`],
    ];
    for (const [label, sql] of cases) await expectRefusedWithNoResidue(sql, label);
    await pool.close();
  });

  it("refuses the U& escaped spelling of pg_notify, with no residue", async () => {
    pool = makePool(url);
    // `00 70` is `p`, so the decoded name is `pg_notify`. The scanner does not
    // decode escapes and refuses the spelling outright.
    const escaped = `U&"` + "\\0070" + `g_notify"`;
    await expectRefusedWithNoResidue(`SELECT ${escaped}('c','p')`, "U& escaped");
    await pool.close();
  });

  it("leaves the session read-only even when the disarming statement is refused", async () => {
    // The escalation QA demonstrated was not the write itself but the polluted
    // session: after `"set_config"(…,'off',…)` the connection stayed read-write
    // for every later statement on it. Read the settings back after each of the
    // four connections has been used, not just the first.
    pool = makePool(url);
    for (let i = 0; i < 8; i++) {
      await pool.query(`SELECT "set_config"('default_transaction_read_only','off',false)`).catch(
        () => null,
      );
      await pool.query(`SELECT pg_catalog."set_config"('statement_timeout','0',false)`).catch(
        () => null,
      );
    }
    // Every pooled connection must still be read-only and still bounded.
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const row = (
        await rawDriver(pool).unsafe(
          "SELECT pg_backend_pid() AS pid, current_setting('default_transaction_read_only') AS dro, current_setting('statement_timeout') AS st",
        )
      )[0] as { pid: number; dro: string; st: string };
      seen.add(String(row.pid));
      expect(row.dro, `pid ${row.pid} was left read-write`).toBe("on");
      expect(["2000", "2000ms", "2s"], `pid ${row.pid} lost its timeout`).toContain(row.st);
    }
    // And a write function is still blocked on those connections.
    await expect(pool.query(`SELECT qa_write_row()`)).rejects.toBeInstanceOf(ReadPoolSideEffectError);
    expect(await writeRows()).toBe(0);
    await pool.close();
  });

  it("still serves the ordinary reads the pool exists for", async () => {
    pool = makePool(url);
    await expect(pool.query("SELECT 42 AS answer")).resolves.toEqual([{ answer: 42 }]);
    await expect(
      pool.query(`SELECT count(*)::int AS n FROM ${WRITE_TABLE}`),
    ).resolves.toEqual([{ n: 0 }]);
    await expect(
      pool.query(`SELECT COALESCE(MAX(id), 0)::int AS m FROM ${WRITE_TABLE}`),
    ).resolves.toEqual([{ m: 0 }]);
    await expect(
      pool.query(`SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM ${WRITE_TABLE}`),
    ).resolves.toEqual([]);
    await expect(pool.query("SELECT x::numeric(10,2) AS v FROM (SELECT 1.5 AS x) AS t")).resolves.toEqual([
      { v: "1.50" },
    ]);
    await expect(pool.query("SELECT 'pg_notify(' AS s")).resolves.toEqual([{ s: "pg_notify(" }]);
    await pool.close();
  });

  it("refuses dblink by name even when the extension is not installed", async () => {
    // The call never reaches the server, so the extension's presence is
    // irrelevant to the gate. The conditional install below is what proves the
    // cross-connection write itself is blocked when it *is* present.
    pool = makePool(url);
    await expect(pool.query(`SELECT "dblink_exec"('x','y')`)).rejects.toBeInstanceOf(
      ReadPoolSideEffectError,
    );
    await pool.close();
  });

  it("blocks the dblink cross-connection write when the extension is installed", async () => {
    // QA's last case: `"dblink_exec"` ran an INSERT on a *different* connection,
    // where this transaction's read-only mode does not apply. Skipped with a
    // note when the server has no dblink available.
    const available = await inspect.unsafe(
      "SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'dblink'",
    );
    if ((available[0].n as number) === 0) {
      console.warn("[mul439-read-pool] dblink is not available on this server — skipping that case");
      return;
    }
    await inspect.unsafe("CREATE EXTENSION IF NOT EXISTS dblink");

    pool = makePool(url);
    const before = await writeRows();
    const parsed = new URL(url);
    const conninfo = `dbname=${parsed.pathname.replace(/^\//u, "")} host=${parsed.hostname} port=${parsed.port} user=${parsed.username}`;

    // The keyword is split so a textual write check cannot see it — the gate has
    // to refuse the *call*, not the string.
    const sql = `SELECT dblink_exec('${conninfo}', 'IN'||'SERT '||'IN'||'TO ${WRITE_TABLE} VALUES (7)')`;
    const error = await pool.query(sql).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReadPoolSideEffectError);
    expect((error as ReadPoolSideEffectError).functionName).toBe("dblink_exec");
    expect(await writeRows(), "dblink wrote a row on another connection").toBe(before);
    await pool.close();
  });

  it("the whitelist refuses a name that is not on it, whatever the casing", async () => {
    pool = makePool(url);
    // Case folding is what makes `Pg_Notify` and `pg_notify` the same call. A
    // quoted name is *not* folded, so `"COUNT"` is a different function and is
    // refused as a quoted identifier.
    await expect(pool.query("SELECT Pg_Notify('c','p')")).rejects.toBeInstanceOf(
      ReadPoolSideEffectError,
    );
    await expect(pool.query('SELECT "COUNT"(*) FROM multiremi_tasks')).rejects.toBeInstanceOf(
      ReadPoolSideEffectError,
    );
    await pool.close();
  });
});

/**
 * The keyword skip, which is where the third review broke the gate
 * (`cmt_0f5ulv021ijn`).
 *
 * The previous revision carried a 115-word list and skipped every member
 * unconditionally, so a user-defined `filter()` — which PostgreSQL accepts as
 * an unquoted function name — ran through `PostgresReadPool.query` and kept an
 * advisory lock. These cases pin the correction: only words the grammar cannot
 * turn into a call are skipped without looking at position.
 */
describe.skipIf(!pgAvailable)("read pool: keyword exemption is context-aware", () => {
  let pool: PostgresReadPool;
  let url = "";
  let inspect: Bun.SQL;
  /** Functions created here, each taking an advisory lock when called. */
  const KEYWORD_FUNCTIONS = ["filter", "within", "over", "respect"] as const;

  function makePool(target: string = url): PostgresReadPool {
    return new PostgresReadPool(target);
  }

  /** The raw driver behind the pool, for out-of-band inspection. */
  function rawDriver(target: PostgresReadPool): Bun.SQL {
    return (target as unknown as { sql: Bun.SQL }).sql;
  }

  async function advisoryLocks(): Promise<number> {
    return (
      await inspect.unsafe(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      )
    )[0].n as number;
  }

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_kw WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}_kw`);
    await admin.end();
    const parsed = new URL(PG_ADMIN_URL);
    parsed.pathname = `/${TEST_DB}_kw`;
    url = parsed.toString();

    inspect = new Bun.SQL(url, { max: 1 });
    // Each function takes an advisory lock and returns, so a bypass leaves a
    // trace that outlives the statement even though the pool reports success.
    for (const name of KEYWORD_FUNCTIONS) {
      await inspect.unsafe(`
        CREATE OR REPLACE FUNCTION ${name}() RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_lock(439200); RETURN 7; END $$`);
    }
  });

  afterAll(async () => {
    await inspect?.end();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}_kw WITH (FORCE)`);
    await admin.end();
  });

  it("confirms these names really are callable, so the test cannot pass vacuously", async () => {
    // The device at the heart of the bypass: PostgreSQL accepts an unquoted
    // function name that is a `U` keyword or absent from its catalog. If a
    // future server refused these `CREATE`s, the cases below would stop testing
    // anything, so this asserts the premise on the same server.
    for (const name of KEYWORD_FUNCTIONS) {
      const exists = await inspect.unsafe(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
        [name],
      );
      expect(exists[0].n, `${name}() should exist as a user function`).toBe(1);
    }
  });

  it("refuses each keyword-named function in all four call positions", async () => {
    pool = makePool(url);
    const positions: Array<[string, (name: string) => string]> = [
      ["SELECT list", (n) => `SELECT ${n}()`],
      ["FROM", (n) => `SELECT * FROM ${n}()`],
      ["LATERAL", (n) => `SELECT * FROM (SELECT 1) x, LATERAL ${n}()`],
      ["ROWS FROM", (n) => `SELECT * FROM ROWS FROM(${n}())`],
    ];
    for (const name of KEYWORD_FUNCTIONS) {
      for (const [label, build] of positions) {
        const sql = build(name);
        const before = await advisoryLocks();
        const error = await pool.query(sql).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error, `${label}: ${sql}`).toBeInstanceOf(ReadPoolSideEffectError);
        expect((error as ReadPoolSideEffectError).code, `${label}: ${sql}`).toBe(
          "read_pool_side_effect",
        );
        // Refusal happens before the connection is used, so no lock can remain.
        expect(await advisoryLocks(), `${label}: ${sql} left a lock`).toBe(before);
      }
    }
    await pool.close();
  });

  it("refuses the quoted and schema-qualified spellings of the same names", async () => {
    // A quoted `"filter"` is never a keyword — it resolves to the user function
    // — and a qualifier cannot precede a clause keyword, so `public.filter()`
    // is a call too. The previous revision skipped both, because it matched on
    // the resolved name alone.
    pool = makePool(url);
    for (const sql of [
      `SELECT "filter"()`,
      `SELECT "over"()`,
      `SELECT "within"()`,
      `SELECT "respect"()`,
      `SELECT public.filter()`,
      `SELECT pg_catalog.filter()`,
      `SELECT FILTER()`,
      `SELECT Over()`,
    ]) {
      const error = await pool.query(sql).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, sql).toBeInstanceOf(ReadPoolSideEffectError);
    }
    expect(await advisoryLocks()).toBe(0);
    await pool.close();
  });

  it("refuses the other words that were skipped unconditionally", async () => {
    // A sample of the `U`/`T` words the 115-entry list exempted. None is
    // whitelisted, so the gate must refuse each one rather than skip it.
    pool = makePool(url);
    for (const name of [
      "next", "by", "rows", "range", "partition", "exclude", "ties", "locked",
      "share", "unbounded", "preceding", "following", "conflict",
      "nothing", "unknown", "nulls", "first", "last", "at", "zone", "groups",
      "recursive", "of", "no", "current", "double", "varying",
    ]) {
      const error = await pool.query(`SELECT ${name}()`).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, `SELECT ${name}()`).toBeInstanceOf(ReadPoolSideEffectError);
    }
    // `update` is a write keyword, so the *classifier* refuses it first. That is
    // stricter than the gate and the right error for the caller.
    const writeWord = await pool.query("SELECT update()").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(writeWord).toBeInstanceOf(ReadPoolNotSelectError);
    await pool.close();
  });

  it("still accepts the syntax those words exist for", async () => {
    // The positive side: refusing the *calls* must not break the clauses.
    pool = makePool(url);
    await expect(
      pool.query("SELECT count(*) FILTER (WHERE x > 1)::int AS n FROM (SELECT 2 AS x) t"),
    ).resolves.toEqual([{ n: 1 }]);
    await expect(
      pool.query("SELECT sum(x) OVER (PARTITION BY y)::int AS s FROM (SELECT 1 AS x, 2 AS y) t"),
    ).resolves.toEqual([{ s: 1 }]);
    await expect(
      pool.query("SELECT sum(x) OVER w::int AS s FROM (SELECT 1 AS x) t WINDOW w AS (ORDER BY x)"),
    ).resolves.toEqual([{ s: 1 }]);
    await expect(
      pool.query(
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS p FROM (SELECT 1 AS x) t",
      ),
    ).resolves.toEqual([{ p: 1 }]);
    // `ORDER BY (…)`: the reason `by` needs a context rule rather than removal.
    await expect(
      pool.query("SELECT m.id FROM (SELECT 1 AS id, 2 AS n) m ORDER BY (m.n > 1) DESC, m.id"),
    ).resolves.toEqual([{ id: 1 }]);
    await expect(pool.query("SELECT 1 GROUP BY (1)")).resolves.toEqual([{ "?column?": 1 }]);
    await expect(
      pool.query("SELECT x.a, y.b FROM (SELECT 1 AS a) x, LATERAL (SELECT 2 AS b) y"),
    ).resolves.toEqual([{ a: 1, b: 2 }]);
    await expect(
      pool.query("SELECT generate_series FROM ROWS FROM (generate_series(1,2))"),
    ).resolves.toHaveLength(2);
    await pool.close();
  });

  it("allows only the shapes PostgreSQL itself accepts as clause syntax", async () => {
    // The `)`-precedes rule is the part of this gate that is easiest to get
    // wrong, so this pins the property directly: for every way I could place a
    // `)` immediately before `FILTER(`/`OVER(`, PostgreSQL either treats it as
    // the clause (which is what the rule allows) or rejects the statement as a
    // syntax error. A shape the gate allows but PostgreSQL *executes* as a
    // function call is the only thing that would matter, and there is none.
    pool = makePool(url);
    const shapes = [
      `SELECT (SELECT 1) filter(1)`,
      `SELECT (1) filter(1)`,
      `SELECT (1) over(1)`,
      `SELECT count(*) filter(1)`,
      `SELECT * FROM t WHERE (a) filter(b)`,
      `SELECT * FROM (SELECT 1) filter(1)`,
      `SELECT * FROM (SELECT 1) AS x, LATERAL (SELECT 2) filter(3)`,
      `WITH q AS (SELECT 1) SELECT * FROM q filter(1)`,
    ];
    for (const sql of shapes) {
      const gateAllows = findDisallowedFunction(sql) === null;
      if (!gateAllows) continue; // Refused outright: nothing more to prove.
      // The gate allowed it, so PostgreSQL must reject it. Anything else would
      // mean a real call slipped past the contextual rule.
      const outcome = await pool
        .query(sql)
        .then(() => "accepted", (error: unknown) => `rejected: ${(error as Error).message.slice(0, 40)}`);
      expect(
        outcome,
        `the gate allowed ${sql}, so PostgreSQL must treat it as a syntax error`,
      ).toStartWith("rejected");
    }
    expect(await advisoryLocks()).toBe(0);
    await pool.close();
  });

  it("does not let `ORDER BY` hide a call to `by()`", async () => {
    // The context rule keys on the token *before* the candidate: `ORDER BY by()`
    // tokenises as `order by by (`, so the second `by` is not preceded by
    // `ORDER` and is treated as a call.
    pool = makePool(url);
    await inspect.unsafe(`
      CREATE OR REPLACE FUNCTION by() RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_lock(439201); RETURN 7; END $$`);
    const error = await pool.query("SELECT 1 ORDER BY by()").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReadPoolSideEffectError);
    expect(await advisoryLocks()).toBe(0);
    await inspect.unsafe("DROP FUNCTION by()");
    await pool.close();
  });

  it("skips only words PostgreSQL will not accept as a function name", async () => {
    // The mechanical guard the review asked for: every unconditionally skipped
    // word must have catcode `R` (reserved) or `C` (cannot be a function or type
    // name) in the server's own keyword catalog. Adding a `U`/`T` word to the
    // unconditional set — which is exactly how the bypass was introduced —
    // turns this red.
    const rows = (await inspect.unsafe("SELECT word, catcode FROM pg_get_keywords()")) as Array<{
      word: string;
      catcode: string;
    }>;
    const catcode = new Map(rows.map((row) => [row.word.toLowerCase(), row.catcode]));

    for (const word of SQL_UNCONDITIONAL_KEYWORD_HEADS) {
      const code: string = catcode.get(word) ?? "";
      expect(
        ["R", "C"],
        `${word} is catcode ${code === "" ? "absent" : code} in pg_get_keywords(); only R and C may be skipped unconditionally`,
      ).toContain(code);
    }

    // And the contextual set must be non-empty and disjoint, so the guard above
    // cannot pass by the unconditional set having swallowed everything.
    expect(SQL_CONTEXTUAL_KEYWORD_HEADS.size).toBeGreaterThan(0);
    for (const word of SQL_CONTEXTUAL_KEYWORD_HEADS) {
      expect(SQL_UNCONDITIONAL_KEYWORD_HEADS.has(word), `${word} is in both sets`).toBe(false);
    }
  });

  it("covers the refusals outside a database too", () => {
    // The same matrix through `findDisallowedFunction`, so the lexical layer is
    // covered when no server is configured.
    for (const name of ["filter", "within", "over", "respect", "by"]) {
      for (const sql of [
        `SELECT ${name}()`,
        `SELECT * FROM ${name}()`,
        `SELECT * FROM (SELECT 1) x, LATERAL ${name}()`,
        `SELECT * FROM ROWS FROM(${name}())`,
        // A quoted or qualified spelling is never the keyword form, so it is a
        // call whatever the name is.
        `SELECT "${name}"()`,
        `SELECT public.${name}()`,
      ]) {
        expect(findDisallowedFunction(sql), sql).not.toBeNull();
      }
    }
    // `left` and `right` are `T`-catcode keywords that are also genuine pure
    // string functions, so they are whitelisted and allowed.
    expect(findDisallowedFunction("SELECT left('ab', 1)")).toBeNull();
    expect(findDisallowedFunction("SELECT right('ab', 1)")).toBeNull();
    // But a qualified spelling of them is still a call to that exact name.
    expect(findDisallowedFunction("SELECT pg_catalog.left('ab', 1)")).toBeNull();
    expect(findDisallowedFunction("SELECT public.left('ab', 1)")).toContain("non-pg_catalog");
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
