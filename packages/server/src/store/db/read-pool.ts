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
 * ## Threat model, and what this gate is for
 *
 * The pool only ever runs SQL that server-side code wrote. It is not an
 * ad-hoc query console, and no caller may put user data into the statement
 * text: parameters go through `$n` bindings, which the driver sends out of
 * band. The gate below is a **default-deny guard against developer mistakes** —
 * a query that quietly gains a function call with an effect, a copy-pasted
 * statement that is not a read at all.
 *
 * It is explicitly **not** a sandbox for hostile SQL. A determined author with
 * the ability to write arbitrary statements can reach a function nobody put on
 * the whitelist only if that name is spelled in the same lower-case form the
 * whitelist uses, but the honest statement of the boundary is this: the real
 * protection for hostile SQL is database permissions on the role the pool
 * connects with — `REVOKE EXECUTE` on the functions it does not need, no
 * `dblink`/`postgres_fdw`, no `pg_read_server_files`. Those changes belong to
 * the production role on 209 and are tracked separately by the squad lead; they
 * are not something this file can do.
 *
 * ## Shape
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
 * ## The two layers, and which one covers what
 *
 * **Layer 1 — every statement runs in its own `BEGIN READ ONLY` transaction**
 * with `SET LOCAL statement_timeout`. This is the layer that stops *writes*.
 * The transaction mode is fixed when it opens, so a session default changed by
 * an earlier statement cannot reopen it; `SET TRANSACTION READ WRITE` would,
 * and is rejected by the classifier as a `SET`. `SET LOCAL` is
 * transaction-scoped, so a disarmed session setting cannot lift the timeout and
 * the timeout cannot outlive the transaction.
 *
 * **Layer 2 — a default-deny function whitelist.** A read-only transaction does
 * not stop every function. `pg_notify` delivers, `pg_advisory_lock` leaves a
 * lock behind, `pg_terminate_backend` kills another connection, `nextval`
 * advances a sequence, `lo_export` and `pg_read_file` touch the filesystem, and
 * `dblink_exec` runs a statement on a *different* connection where this
 * transaction's read-only mode does not apply. Those are refused before the
 * statement is sent: {@link scanSqlFunctionCalls} resolves every call the way
 * PostgreSQL resolves it, and {@link findDisallowedFunction} rejects anything
 * that is not on {@link READ_FUNCTION_WHITELIST}.
 *
 * Why a whitelist and not the earlier denylist: two rounds of review
 * (`cmt_u0bywkppcajq`, `cmt_w08j1ocyurc6`) broke a denylist twice, once with
 * `pg_catalog.set_config` and once with `"set_config"` — PostgreSQL accepts a
 * quoted spelling of every function name, so a list of forbidden names cannot
 * be completed. Enumerating what is *known safe* fails closed instead.
 *
 * Neither layer covers the other's gap, which is why both are here: the
 * transaction cannot stop `pg_notify` or an advisory lock, and the whitelist
 * cannot tell a write function (`SELECT my_write_fn()`) from a pure one — that
 * one only fails because the transaction it runs in is read-only.
 */
import { createLogger } from "@shared/logger.js";
import { scrubErrorForLog } from "@multiremi/store/db/dsn-redaction.js";
import { translateSqliteToPg, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { maskSqlLiterals, scanSqlFunctionCalls } from "@multiremi/store/db/sql-calls.js";

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
  const disallowed = findDisallowedFunction(sql);
  if (disallowed) throw new ReadPoolSideEffectError(disallowed);
}

/** Leading whitespace, applied repeatedly while it keeps matching. */
const LEADING_NOISE_RE = /^\s+/;

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
 * Functions a read statement is allowed to call.
 *
 * **Adding an entry requires showing it has no side effect.** "It worked when I
 * tried it" is not the bar: the function has to be pure with respect to
 * everything outside the query — no writes to any table or sequence, no locks,
 * no notifications, no filesystem or large-object access, no other backends, no
 * remote connections. When in doubt, leave it out; a query that needs a missing
 * function fails closed with `read_pool_side_effect`, which is a bug report
 * against this list rather than a silent hole.
 *
 * The list is grouped by purpose and is intentionally small: the pool serves
 * the conversation-log window, the SSR first paint and the Live Hub warm-up,
 * not arbitrary analytics. The unit test pins the size so the documented number
 * cannot drift from the code.
 *
 * Removed after review (MUL-439 `cmt_0f5ulv021ijn`): `random`. It advances the
 * session's PRNG state, which is a (mild) mutation, and no caller in
 * `packages/server/src` uses it — the two `random()` hits in the tree are
 * JavaScript `Math.random` and the unrelated `worker` helpers, not SQL. If a
 * read ever needs it, the argument for re-adding it is about reproducibility
 * rather than purity, and the note here should be updated with that reason.
 */
export const READ_FUNCTION_WHITELIST: ReadonlySet<string> = new Set<string>([
  // ── aggregates ──
  "count",
  "sum",
  "min",
  "max",
  "avg",
  "array_agg",
  "string_agg",
  "json_agg",
  "jsonb_agg",
  "bool_and",
  "bool_or",
  "every",
  "stddev",
  "variance",
  "percentile_cont",
  "percentile_disc",
  "mode",
  // ── window functions ──
  "row_number",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
  "ntile",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
  // ── JSON construction and access ──
  "json_build_object",
  "jsonb_build_object",
  "json_build_array",
  "jsonb_build_array",
  "json_object",
  "jsonb_object",
  "json_array",
  "jsonb_array",
  "to_json",
  "to_jsonb",
  "row_to_json",
  "jsonb_array_length",
  "json_array_length",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "json_extract_path",
  "json_extract_path_text",
  "jsonb_typeof",
  "json_typeof",
  "jsonb_object_keys",
  "json_object_keys",
  "jsonb_pretty",
  // ── strings ──
  "lower",
  "upper",
  "length",
  "char_length",
  "character_length",
  "octet_length",
  "bit_length",
  "substr",
  "substring",
  "replace",
  "concat",
  "concat_ws",
  "trim",
  "ltrim",
  "rtrim",
  "btrim",
  "lpad",
  "rpad",
  "repeat",
  "reverse",
  "split_part",
  "strpos",
  "position",
  "starts_with",
  // `left` and `right` are `T`-catcode keywords (reserved, but allowed as a
  // function name) and also genuine string functions. Because they are
  // callable, they belong here rather than in the keyword skip; both are pure:
  // they take a string and a count and return a substring.
  "left",
  "right",
  "initcap",
  "md5",
  "encode",
  "decode",
  "quote_ident",
  "quote_literal",
  "quote_nullable",
  "regexp_replace",
  "regexp_match",
  "regexp_matches",
  "regexp_split_to_array",
  "regexp_split_to_table",
  "to_hex",
  "translate",
  "ascii",
  "chr",
  // ── numbers ──
  "abs",
  "round",
  "floor",
  "ceil",
  "ceiling",
  "trunc",
  "sign",
  "mod",
  "power",
  "sqrt",
  "exp",
  "ln",
  "log",
  "greatest",
  "least",
  "width_bucket",
  // ── date and time (all read the clock or convert; none set it) ──
  "now",
  "clock_timestamp",
  "statement_timestamp",
  "transaction_timestamp",
  "current_date",
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
  "age",
  "date_part",
  "date_trunc",
  "date_bin",
  "extract",
  "to_char",
  "to_date",
  "to_timestamp",
  "to_number",
  "make_date",
  "make_time",
  "make_timestamp",
  "make_interval",
  "justify_days",
  "justify_hours",
  "justify_interval",
  "timezone",
  // ── casting and inspection ──
  "cast",
  "coalesce",
  "nullif",
  "pg_typeof",
  "pg_column_size",
  "pg_total_relation_size",
  "pg_relation_size",
  "pg_indexes_size",
  "pg_size_pretty",
  "pg_get_expr",
  "pg_get_indexdef",
  "pg_get_viewdef",
  "pg_get_constraintdef",
  "format",
  "format_type",
  "version",
  "current_database",
  "current_schema",
  "current_schemas",
  "current_user",
  "session_user",
  "current_setting",
  "current_catalog",
  "inet_client_addr",
  "inet_client_port",
  "inet_server_addr",
  "inet_server_port",
  "pg_backend_pid",
  "pg_postmaster_start_time",
  "obj_description",
  "col_description",
  "shobj_description",
  "has_table_privilege",
  "has_column_privilege",
  "has_schema_privilege",
  "has_database_privilege",
  "has_function_privilege",
  "pg_table_is_visible",
  "pg_type_is_visible",
  "pg_function_is_visible",
  "pg_encoding_to_char",
  "array_length",
  "array_lower",
  "array_upper",
  "array_position",
  "array_positions",
  "array_remove",
  "array_replace",
  "array_to_string",
  "array_to_json",
  "cardinality",
  "unnest",
  "generate_series",
  "generate_subscripts",
]);

/**
 * The next statement in `sql` that the pool refuses, or null when the whole
 * statement is allowed.
 *
 * A call is refused when any of these holds:
 *
 * - the name is not on {@link READ_FUNCTION_WHITELIST};
 * - it is schema-qualified with something other than `pg_catalog`;
 * - it was written with a `U&"…"` Unicode escape, whose decoded name this
 *   scanner deliberately does not attempt to resolve;
 * - it was written as a quoted identifier at all, because PostgreSQL treats a
 *   quoted name as *distinct* from the unquoted one — `"COUNT"(*)` is a user
 *   function, not the aggregate, and accepting quoted spellings is how the
 *   previous two gates were defeated.
 *
 * The returned string is what the error reports, so a caller sees the name as
 * PostgreSQL would resolve it.
 */
export function findDisallowedFunction(sql: string): string | null {
  let calls;
  try {
    calls = scanSqlFunctionCalls(sql);
  } catch (error) {
    // An untokenisable statement is refused rather than passed through. The
    // name is the scanner's complaint, so the caller can tell this apart from a
    // plain whitelist miss.
    return `unscannable statement: ${(error as Error).message}`;
  }
  for (const call of calls) {
    if (call.unicodeEscaped) return `${call.name} (U& escaped)`;
    if (call.quoted) return `${call.name} (quoted identifier)`;
    if (call.schema !== null && call.schema !== "pg_catalog") {
      return `${call.schema}.${call.name} (non-pg_catalog schema)`;
    }
    if (!READ_FUNCTION_WHITELIST.has(call.name)) return call.name;
  }
  return null;
}

/**
 * A locking clause. Read-only transactions reject these too, but naming them
 * here gives the caller a clear `read_pool_not_select` at the gate rather than
 * a server error after the round trip.
 *
 * `FOR SHARE`, `FOR KEY SHARE` and `FOR NO KEY UPDATE` are included alongside
 * `FOR UPDATE`: all four take row locks, and `FOR NO KEY UPDATE` is a write
 * lock even though it changes no column.
 */
const LOCKING_CLAUSE_RE = /\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i;

/**
 * A `;` that separates two statements, as opposed to one trailing `;`.
 *
 * The masked text has literals and comments blanked out, so a `;` here is real
 * SQL. `SELECT 1;` is one statement with a terminator and is allowed;
 * `SELECT 1; SELECT 2` is two, and the pool does not accept a batch — the
 * second statement would otherwise reach the server without passing the gate's
 * view of it.
 */
function hasStatementSeparator(masked: string): boolean {
  // Exactly one trailing terminator is allowed, with whitespace either side.
  const withoutTerminator = masked.replace(/\s*;\s*$/u, "");
  return withoutTerminator.includes(";");
}

/**
 * The leading keyword of a statement, or null when it is not a read.
 *
 * Runs on {@link maskSqlLiterals}, the same view of the statement the function
 * gate uses. That is the point: both deciders have to agree on what a string or
 * a comment is, or a statement could be a read to one and a write to the other.
 * With the mask applied, a keyword inside a literal is blanked out and a
 * commented-out keyword cannot hide one.
 *
 * Rejected here, beyond "not a read":
 *
 * - a statement batch (`SELECT 1; SELECT 2`), because only the first statement
 *   would be the one this classifier looked at;
 * - a locking clause (`FOR UPDATE` and its three siblings), which is a write
 *   intent even when the statement is otherwise a read.
 *
 * `EXPLAIN` is allowed because a planner check is a read; `EXPLAIN ANALYZE`
 * executes the statement, and the `ANALYZE` deny below turns that away.
 * `WITH … SELECT` is the store's pagination shape, so it has to pass.
 */
function classifyReadStatement(sql: string): string | null {
  let stripped: string;
  try {
    stripped = maskSqlLiterals(sql).trim();
  } catch {
    // A statement the scanner cannot tokenise is not a read.
    return null;
  }
  for (;;) {
    const next = stripped.replace(LEADING_NOISE_RE, "");
    if (next === stripped) break;
    stripped = next.trim();
  }
  if (!stripped) return null;
  if (hasStatementSeparator(stripped)) return null;
  const head = /^[A-Za-z]+/.exec(stripped)?.[0]?.toUpperCase();
  if (!head || !READ_HEADS.has(head)) return null;
  if (WRITE_KEYWORD_RE.test(stripped)) return null;
  if (LOCKING_CLAUSE_RE.test(stripped)) return null;
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
   * {@link findDisallowedFunction} before the statement is sent.
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
