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
 * - `max: 4` connections, `statement_timeout=2000` on every session;
 * - a client-side abort at 3 s, so a statement the server never times out (a
 *   lock wait reported as `SELECT`, a hung socket) still returns to the caller;
 * - a queue cap of 64; the 65th waiter fails immediately with
 *   `read_pool_saturated`, which the routers map to 503 so the caller can fall
 *   back (SSR renders the shell, the replica fetches) instead of piling up;
 * - connection-level read-only (`default_transaction_read_only=on`) plus a
 *   `SELECT` gate, and never `transaction()`: a read must not join the write
 *   transaction the synchronous store is running;
 * - SQL text goes through `translateSqliteToPg`, so call sites keep emitting
 *   the sqlite dialect the store is written in and each statement has one copy;
 * - on SQLite (the default local backend) this degrades to the synchronous
 *   library, where an async pool would only add latency.
 */
import { createLogger } from "@shared/logger.js";
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
 * Leading whitespace, `--` comments and block comments, in any mix. Applied
 * repeatedly while it keeps matching, so `/* a *\/ -- b\n SELECT …` still
 * resolves to `SELECT`.
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
 * The leading keyword of a statement, or null when it is not a read.
 *
 * `EXPLAIN` is allowed because a planner check is a read; `EXPLAIN ANALYZE`
 * executes the statement, and the `ANALYZE` deny below turns that away.
 * `WITH … SELECT` is the store's pagination shape, so it has to pass.
 */
function classifyReadStatement(sql: string): string | null {
  let stripped = sql.trim();
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
      // Session defaults reach every pooled connection. `statement_timeout` is
      // the server-side ceiling; the read-only default is the enforcing layer
      // behind the textual gate, so a statement that slips past the gate still
      // cannot write. Both are sent as startup parameters.
      connection: {
        statement_timeout: READ_POOL_STATEMENT_TIMEOUT_MS,
        default_transaction_read_only: "on",
      },
      onclose: (err) => {
        if (err) log.warn(`read pool connection closed with error: ${err.message}`);
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
    if (!isReadOnlySelect(sql)) throw new ReadPoolNotSelectError();
    if (this.closed) throw new Error("read pool is closed");
    const timeoutMs = options.timeoutMs ?? READ_POOL_CLIENT_TIMEOUT_MS;
    await this.acquire();
    try {
      return (await this.execute(sql, params, timeoutMs)) as T[];
    } finally {
      this.release();
    }
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

  private execute(sql: string, params: unknown[], timeoutMs: number): Promise<unknown[]> {
    // The gate already translated nothing; translation happens here so a
    // rejected statement never reaches the connection.
    const statement = this.sql.unsafe<unknown[]>(translateSqliteToPg(sql), params);
    // The race means the query can settle after the caller has been told the
    // read timed out. Keep that outcome from surfacing as an unhandled
    // rejection; the statement itself is already cancelled below.
    void Promise.resolve(statement).catch(() => {});

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ReadPoolTimeoutError()), timeoutMs);
    });

    return Promise.race([Promise.resolve(statement), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      // Bun.SQL exposes `cancel()` on the query handle. The probe in
      // MUL-439 shows it does not always stop the server-side statement, which
      // is exactly why the caller gets the client-side abort as well.
      const canceller = statement as unknown as { cancel?: () => void };
      if (typeof canceller.cancel === "function") canceller.cancel();
    });
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
    if (!isReadOnlySelect(sql)) throw new ReadPoolNotSelectError();
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
