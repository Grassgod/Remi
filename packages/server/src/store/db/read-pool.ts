/**
 * The asynchronous read path: a dedicated read-only `Bun.SQL` pool.
 *
 * MUL-383's binding constraints (issue MUL-383, decision `sres_wep8c9z66cef`,
 * restated for MUL-403 in `cmt_u3fltd47w6r0`) require new server-side read
 * paths — SSR first paint, Live Hub warm-up — to use an async direct connection
 * instead of the synchronous Worker/Atomics bridge in `store/db/postgres.ts`.
 * The bridge is what turns a slow read into a stalled event loop; the pool
 * keeps reads off the main thread and bounds what they can cost.
 *
 * Shape (MUL-403 plan 2/6 `cmt_2capihmkhktv` §4, acceptance criteria in the
 * MUL-439 description):
 *
 * - `max: 4` connections;
 * - a client-side abort at 3 s, so a statement the server never times out (a
 *   lock wait reported as `SELECT`, a hung socket) still returns to the caller;
 * - a queue cap of 64; the 65th waiter fails immediately with
 *   `read_pool_saturated`, which the routers map to 503 so the caller can fall
 *   back (SSR renders the shell, the replica fetches) instead of piling up;
 * - SQL text goes through `translateSqliteToPg`, so call sites keep emitting
 *   the sqlite dialect the store is written in and each statement has one copy;
 * - on SQLite (the default local backend) this degrades to the synchronous
 *   library, where an async pool would only add latency.
 *
 * ## Why "read only" is layered rather than a session default
 *
 * The first cut relied on `default_transaction_read_only=on` plus a textual
 * gate. Independent review (MUL-439 `cmt_u0bywkppcajq`) showed two ways
 * through it, both reproduced here before the fix:
 *
 * 1. `SELECT set_config('default_transaction_read_only','off',false)` changes
 *    the *session* default, so the next statement on that pooled connection
 *    runs read-write — a write function then inserted a row. The same trick
 *    with `statement_timeout` disarmed the 2 s ceiling.
 * 2. A `SELECT` that calls a side-effecting function (`pg_notify`,
 *    `pg_advisory_lock*`, `pg_terminate_backend`, …) passed the gate and took
 *    effect, because a read-only transaction does not stop every function.
 *
 * So the pool no longer trusts session state at all:
 *
 * - **Every statement runs inside its own `BEGIN READ ONLY` transaction.** The
 *   mode is fixed when the transaction starts, so a session default changed
 *   earlier cannot reopen it, and `SET TRANSACTION READ WRITE` is refused once
 *   a transaction is active. The timeout is applied with
 *   `SET LOCAL statement_timeout`, which is transaction-scoped: a disarmed
 *   session setting cannot lift it, and it cannot outlive the transaction.
 * - **The gate rejects side-effecting calls by name.** See
 *   {@link FORBIDDEN_FUNCTION_RE}. This is the layer that covers what a
 *   read-only transaction does not: `pg_notify`, advisory locks, backend
 *   termination, large-object and file functions. The denylist is deliberately
 *   conservative — a function it does not know about is allowed, so the
 *   transaction remains the enforcement layer for writes and this list is for
 *   the effects that are *not* writes.
 *
 * The two layers are complementary, and each covers a bypass the other misses:
 * the transaction cannot stop `pg_notify` or an advisory lock, and the denylist
 * cannot tell a write function (`SELECT my_write_fn()`) from a read one.
 */
import { createLogger } from "@shared/logger.js";
import { scrubErrorForLog } from "@multiremi/store/db/dsn-redaction.js";
import { translateSqliteToPg, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const log = createLogger("read-pool");

/** Connections in the read pool. Small on purpose: reads must not crowd out writes. */
export const READ_POOL_MAX_CONNECTIONS = 4;
/** Callers allowed to wait for a connection at once; the next one is rejected. */
export const READ_POOL_QUEUE_LIMIT = 64;
/** Server-side `statement_timeout`, in milliseconds. */
export const READ_POOL_STATEMENT_TIMEOUT_MS = 2_000;
/** Client-side abort, in milliseconds. Stays above the server-side timeout. */
export const READ_POOL_CLIENT_TIMEOUT_MS = 3_000;

/**
 * Raised when the queue is full. Routers map this to 503 and let the caller
 * fall back; it must never be retried inside the pool.
 */
export class ReadPoolSaturatedError extends Error {
  readonly code = "read_pool_saturated";
  constructor(message = "read pool is saturated") {
    super(message);
    this.name = "ReadPoolSaturatedError";
  }
}

/** Raised when a statement outlived the client-side abort. */
export class ReadPoolTimeoutError extends Error {
  readonly code = "read_pool_timeout";
  constructor(message = "read query timed out") {
    super(message);
    this.name = "ReadPoolTimeoutError";
  }
}

/** Raised when SQL text that is not a read reaches the pool. */
export class ReadPoolNotSelectError extends Error {
  readonly code = "read_pool_not_select";
  constructor(message = "read pool only accepts SELECT statements") {
    super(message);
    this.name = "ReadPoolNotSelectError";
  }
}

/**
 * Raised when a read calls a function with effects a read-only transaction does
 * not stop. Separate from {@link ReadPoolNotSelectError} so a caller (and a
 * log) can tell "this is a write" from "this read has side effects".
 */
export class ReadPoolSideEffectError extends Error {
  readonly code = "read_pool_side_effect";
  constructor(readonly functionName: string) {
    super(`read pool refuses the side-effecting function "${functionName}"`);
    this.name = "ReadPoolSideEffectError";
  }
}

export interface ReadPoolQueryOptions {
  /** Overrides {@link READ_POOL_CLIENT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface ReadPool {
  /** True while this pool executes against Postgres. */
  readonly postgres: boolean;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: ReadPoolQueryOptions,
  ): Promise<T[]>;
  /** First row, or null when the read returned nothing. */
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: ReadPoolQueryOptions,
  ): Promise<T | null>;
  close(): Promise<void>;
}

/**
 * The HTTP status a read-pool failure maps to, or null when the error is not
 * the pool's. Saturation is the one the plan calls out (503, SSR falls back);
 * a timeout is the same class of "try again" answer.
 */
export function readPoolErrorStatus(error: unknown): 503 | null {
  if (error instanceof ReadPoolSaturatedError) return 503;
  if (error instanceof ReadPoolTimeoutError) return 503;
  if (
    error instanceof Error &&
    (error as { code?: string }).code === "read_pool_saturated"
  ) {
    return 503;
  }
  return null;
}

/** True when `sql` names a statement that only reads. */
export function isReadOnlySelect(sql: string): boolean {
  return classifyReadStatement(sql) !== null;
}

/**
 * Refuse anything the pool must not run: a non-read, then a read that calls a
 * side-effecting function.
 *
 * Both arms call this, so the SQLite and Postgres paths agree on what a read
 * is even though only Postgres can enforce it underneath.
 */
function assertReadOnlyStatement(sql: string): void {
  if (classifyReadStatement(sql) === null) throw new ReadPoolNotSelectError();
  const forbidden = findForbiddenFunction(sql);
  if (forbidden) throw new ReadPoolSideEffectError(forbidden);
}

/**
 * Leading whitespace and any remaining comments, in any mix. Applied
 * repeatedly while it keeps matching, so a statement preceded by a block
 * comment and a line comment still resolves to its keyword.
 */
const LEADING_NOISE_RE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/**
 * Statements that write, or that change session state the pool depends on.
 *
 * `INTO` covers `SELECT … INTO new_table`; `SET`/`BEGIN` and the transaction
 * verbs cover escaping the read-only session or the statement timeout. Word
 * boundaries keep `updated_at` and `created_at` out of the deny list.
 */
const WRITE_KEYWORD_RE =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|CALL|DO|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|DISCARD|INTO|RETURNING)\b/i;

/** Statement kinds the pool accepts as reads. */
const READ_HEADS = new Set(["SELECT", "VALUES", "TABLE", "WITH", "EXPLAIN", "SHOW"]);

/**
 * Functions the pool refuses, because a read-only transaction does not stop
 * them and each one has an effect outside the query.
 *
 * Grouped by what they do, so a new entry has an obvious home:
 *
 * - **session/config mutation** — `set_config` is how a caller disarms the
 *   read-only default or the statement timeout. The pool sets both itself, per
 *   transaction, and does not let a statement change them.
 * - **notifications** — `pg_notify` delivers to listeners; it is a write to the
 *   outside world even though it touches no table.
 * - **locks** — the advisory lock family takes a lock that outlives the
 *   statement, which is how a read is turned into a denial of service. The
 *   `_xact_` variants hold until the transaction ends, so they are refused too:
 *   nothing in this pool needs a lock.
 * - **other backends** — `pg_terminate_backend` / `pg_cancel_backend` kill
 *   someone else's work.
 * - **sequences** — `nextval` / `setval` mutate a sequence even where tables
 *   are read-only.
 * - **large objects and server files** — `lo_*` mutate the large-object store;
 *   `pg_read_file`, `pg_read_binary_file` and `pg_ls_dir` read the server's
 *   filesystem, which is not this pool's data.
 * - **remote execution** — `dblink*` and `postgres_fdw`'s remote work run
 *   statements on another database.
 *
 * Matching is on the call form `name(`, not a bare name, so a column or alias
 * that merely contains one of these words is not caught. The list is matched
 * against the stripped statement (comments removed by
 * {@link stripComments}), which is what stops
 * a comment wedged between a function name and its parenthesis from slipping
 * through (for example `pg_notify` split by a block comment).
 */
const FORBIDDEN_FUNCTIONS = [
  "set_config",
  "pg_notify",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "nextval",
  "setval",
  "lo_create",
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_put",
  "lowrite",
  "lo_open",
  "lo_close",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_archive_statusdir",
  "pg_ls_tmpdir",
  "dblink",
  "dblink_connect",
  "dblink_exec",
  "dblink_send_query",
  "dblink_open",
  "dblink_fetch",
  "dblink_close",
  "dblink_disconnect",
  "dblink_cancel_query",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_log_backend_memory_contexts",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_promote",
  "pg_backup_start",
  "pg_backup_stop",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_wal_replay_pause",
  "pg_wal_replay_resume",
  "pg_import_system_collations",
  "pg_export_snapshot",
  "pg_replication_origin_advance",
  "pg_replication_origin_create",
  "pg_replication_origin_drop",
  "pg_replication_origin_session_setup",
  "pg_create_logical_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_drop_replication_slot",
  "pg_stat_reset",
  "pg_stat_reset_shared",
  "pg_stat_reset_single_table_counters",
  "pg_stat_reset_single_function_counters",
  "pg_stat_reset_slru",
  "pg_stat_reset_replication_slot",
] as const;

/**
 * `name(` with an optional schema qualifier, so `pg_catalog.set_config(` is
 * caught as well. Built from the list rather than hand-written so an entry
 * cannot be forgotten here.
 */
const FORBIDDEN_FUNCTION_RE = new RegExp(
  String.raw`(?:^|[^\w$])(?:[a-z_][a-z0-9_$]*\.)?(` +
    FORBIDDEN_FUNCTIONS.join("|") +
    String.raw`)\s*\(`,
  "i",
);

/**
 * The side-effecting function a statement calls, or null.
 *
 * Exported so a caller can explain a refusal, and so the test can assert the
 * list directly rather than only through the pool.
 */
export function findForbiddenFunction(sql: string): string | null {
  // The name is captured by the group, so the boundary character the pattern
  // needs (start of string, or a non-identifier separator) is not part of it.
  const match = FORBIDDEN_FUNCTION_RE.exec(stripComments(sql));
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Remove line comments and block comments.
 *
 * The classifier and the function gate both run on the result, which is what
 * makes a comment-split `SELECT 1` and a comment-split `set_config` behave like their
 * uncommented forms. `$$`-quoted bodies are left alone: a function *body*
 * mentioning `pg_notify` is not a call to it, and {@link FORBIDDEN_FUNCTION_RE}
 * needs the `(` immediately after the name to match.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * The leading keyword of a statement, or null when it is not a read.
 *
 * `EXPLAIN` is allowed because a planner check is a read; `EXPLAIN ANALYZE`
 * executes the statement, and the `ANALYZE` deny below turns that away.
 * `WITH … SELECT` is the store's pagination shape, so it has to pass.
 */
function classifyReadStatement(sql: string): string | null {
  // Comments are removed first, so `SELECT/*x*/1` and a keyword split by a
  // comment cannot hide behind one. `$1`-style placeholders and quoted strings
  // survive, which is all the classifier looks at.
  let stripped = stripComments(sql).trim();
  for (;;) {
    const next = stripped.replace(LEADING_NOISE_RE, "");
    if (next === stripped) break;
    stripped = next.trim();
  }
  if (!stripped) return null;
  const head = /^[A-Za-z]+/.exec(stripped)?.[0]?.toUpperCase();
  if (!head || !READ_HEADS.has(head)) return null;
  if (WRITE_KEYWORD_RE.test(stripped)) return null;
  return head;
}

/**
 * A loggable form of a statement: the leading keyword and a byte count.
 *
 * Deliberately not the SQL text. A read statement can carry identifiers and
 * literals that do not belong in a log line, and the only thing an operator
 * needs from an aborted read is which shape of query it was. `db` statements
 * are recorded through the existing metrics instead.
 */
function describeStatement(sql: string): string {
  const keyword = /^[A-Za-z]+/.exec(sql.trim())?.[0]?.toUpperCase() ?? "?";
  return `${keyword} (${sql.length} chars)`;
}

/** One queued caller: the promise body plus whether it has been handed a slot. */
interface QueuedWaiter {
  grant: () => void;
  reject: (reason: unknown) => void;
}

/**
 * The Postgres read pool. {@link createReadPool} returns this when the
 * configured database is Postgres, and the pass-through SQLite arm otherwise;
 * call sites only see the {@link ReadPool} interface.
 */
export class PostgresReadPool implements ReadPool {
  readonly postgres = true;
  private readonly sql: Bun.SQL;
  private running = 0;
  private readonly waiting: QueuedWaiter[] = [];
  private closed = false;

  constructor(url: string) {
    this.sql = new Bun.SQL(url, {
      max: READ_POOL_MAX_CONNECTIONS,
      // Session defaults reach every pooled connection as startup parameters.
      // They are the second layer, not the first: each statement also runs in
      // its own `BEGIN READ ONLY` with a transaction-scoped timeout (see
      // `execute`). Keeping them set means a connection is never read-write
      // even in the gap before a transaction opens, and an operator inspecting
      // a session sees the same intent the pool enforces.
      connection: {
        statement_timeout: READ_POOL_STATEMENT_TIMEOUT_MS,
        default_transaction_read_only: "on",
      },
      onclose: (err) => {
        // Scrubbed: the driver's text is not a contract, and a DSN that reached
        // it would be a credential in the log.
        if (err) log.warn(`read pool connection closed with error: ${scrubErrorForLog(err)}`);
      },
    });
  }

  /** Statements currently executing. */
  get active(): number {
    return this.running;
  }

  /** Callers waiting for a connection. */
  get queued(): number {
    return this.waiting.length;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    options: ReadPoolQueryOptions = {},
  ): Promise<T[]> {
    assertReadOnlyStatement(sql);
    if (this.closed) throw new Error("read pool is closed");
    const timeoutMs = options.timeoutMs ?? READ_POOL_CLIENT_TIMEOUT_MS;
    await this.acquire();

    // The statement's own promise holds the slot, not the caller's view of it.
    // On the abort path the caller is released at its deadline while the
    // transaction is still winding down; tying the slot to the transaction
    // keeps `active` meaning "connections in use", so a burst of aborts cannot
    // push more statements at Bun's pool than the saturation limit allows.
    const work = this.execute(sql, params);
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      this.release();
    };
    void work.then(releaseOnce, releaseOnce);

    return (await this.withTimeout(work, timeoutMs, sql)) as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    options: ReadPoolQueryOptions = {},
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params, options);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new Error("read pool is closed"));
    }
    await this.sql.end({ timeout: 1 });
  }

  /**
   * Run one statement inside its own `BEGIN READ ONLY` transaction.
   *
   * The transaction is the enforcement layer for writes: the mode is fixed when
   * it opens, so a session default changed by an earlier statement cannot
   * reopen it, and `SET TRANSACTION READ WRITE` is refused once it is active.
   * `SET LOCAL statement_timeout` is transaction-scoped, so it cannot be lifted
   * by a session-level setting and cannot outlive the transaction.
   *
   * Note what this does *not* cover: a read-only transaction still permits
   * `pg_notify`, advisory locks and a few other effects. Those are refused by
   * {@link findForbiddenFunction} before the statement is sent.
   */
  private execute(sql: string, params: unknown[]): Promise<unknown[]> {
    // Translation happens here, after the gate, so a rejected statement never
    // reaches a connection.
    const translated = translateSqliteToPg(sql);
    const statementTimeout = Math.trunc(READ_POOL_STATEMENT_TIMEOUT_MS);
    if (!Number.isFinite(statementTimeout) || statementTimeout <= 0) {
      return Promise.reject(new Error("read pool statement timeout must be a positive integer"));
    }
    return this.sql.begin("read only", async (tx) => {
      // `SET LOCAL` takes no bind parameters, hence the interpolation of a
      // value that was just proved to be a positive integer.
      await tx.unsafe(`SET LOCAL statement_timeout = ${statementTimeout}`);
      return (await tx.unsafe<unknown[]>(translated, params)) as unknown[];
    }) as Promise<unknown[]>;
  }

  /**
   * The caller's view of a statement: the result, or `read_pool_timeout` at the
   * client deadline.
   *
   * The client deadline sits above the server's `statement_timeout`, so for a
   * genuinely slow statement the server error wins. This exists for the cases
   * the server never gets to time out — a wait for a connection, a lock the
   * planner reports as a read, a hung socket.
   */
  private async withTimeout(
    work: Promise<unknown[]>,
    timeoutMs: number,
    sql: string,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ReadPoolTimeoutError()), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof ReadPoolTimeoutError) {
        // Best effort: ask the driver to cancel so the connection frees up
        // sooner. The probe in MUL-439 shows this does not reliably stop a
        // statement the server is already running, which is why the client
        // abort is separate from `statement_timeout` rather than a replacement
        // for it.
        const canceller = work as unknown as { cancel?: () => void };
        if (typeof canceller.cancel === "function") canceller.cancel();
        log.warn(`read query aborted at the client deadline: ${describeStatement(sql)}`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Take a connection slot, or queue behind the four that are busy.
   *
   * The queue is what makes saturation visible: past
   * {@link READ_POOL_QUEUE_LIMIT} waiters the call fails immediately rather
   * than adding to a backlog nobody is draining.
   */
  private acquire(): Promise<void> {
    if (this.running < READ_POOL_MAX_CONNECTIONS) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= READ_POOL_QUEUE_LIMIT) {
      return Promise.reject(new ReadPoolSaturatedError());
    }
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({ grant: resolve, reject });
    });
  }

  /** Hand the slot to the next waiter, or give it back to the pool. */
  private release(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.running = Math.max(0, this.running - 1);
      return;
    }
    // The slot moves straight across, so `running` is unchanged.
    next.grant();
  }
}

/**
 * The SQLite arm: same interface, straight through to the synchronous handle.
 *
 * There is no pool to bound and no bridge to bypass — `bun:sqlite` is
 * synchronous in-process — so the queue, the abort timer and the saturation
 * answer would only add latency. The gate stays, because "a read handle never
 * runs a write" is a property of the interface rather than of the backend.
 */
export class SqliteReadPool implements ReadPool {
  readonly postgres = false;
  constructor(private readonly db: SqlDatabase) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    assertReadOnlyStatement(sql);
    return this.db.query(sql).all(...params) as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    // The handle belongs to the store (or to the process-wide sqlite
    // connection); closing it here would take the write path down with it.
  }
}

/**
 * Build the read pool for the configured backend.
 *
 * `databaseUrl` defaults to `MULTIREMI_DATABASE_URL`, matching
 * `openMultiremiDatabase()`, so the pool and the synchronous store always point
 * at the same database. `sqliteDb` supplies the handle used by the SQLite arm.
 */
export function createReadPool(options: {
  databaseUrl?: string | null;
  sqliteDb?: SqlDatabase | null;
} = {}): ReadPool {
  const url = (options.databaseUrl ?? process.env.MULTIREMI_DATABASE_URL ?? "").trim();
  if (/^postgres(ql)?:\/\//i.test(url)) return new PostgresReadPool(url);
  if (!options.sqliteDb) {
    throw new Error("createReadPool needs a sqlite database when no Postgres URL is configured");
  }
  return new SqliteReadPool(options.sqliteDb);
}
