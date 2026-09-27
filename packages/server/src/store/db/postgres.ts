/**
 * Storage abstraction for MultiremiStore.
 *
 * The store is written against the synchronous bun:sqlite surface. To let it run
 * on Postgres without rewriting ~800 synchronous call sites, this module exposes
 * a small `SqlDatabase` interface (which bun:sqlite's Database already satisfies
 * structurally) plus a `PostgresSyncDatabase` implementation that bridges to an
 * async Postgres connection synchronously via a Worker + SharedArrayBuffer +
 * Atomics.wait. Select the backend with `MULTIREMI_DATABASE_URL` (postgres://…);
 * otherwise the shared bun:sqlite database (core Remi's ~/.remi/remi.db) is used.
 */
import { getDb } from "@shared/db/index.js";
import {
  emitDbReplyRejected,
  emitLargeDbReply,
  recordDbParse,
  recordDbQuery,
  resolveDbReplyMaxBytes,
} from "../../observability/request-metrics.js";

export interface SqlStatement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  values(...params: unknown[]): any[][];
}

export interface SqlDatabase {
  query(sql: string): SqlStatement;
  prepare(sql: string): SqlStatement;
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  exec(sql: string): void;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
}

// ────────────────────────────── sqlite → postgres ──────────────────────────────

/** Replace `?` placeholders with `$1, $2, …`, skipping `?` inside single-quoted strings. */
function numberPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      out += "$" + ++n;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Translate the sqlite-dialect SQL the store emits into Postgres-compatible SQL. */
export function translateSqliteToPg(sql: string): string {
  let s = sql;
  const hadInsertOrIgnore = /INSERT\s+OR\s+IGNORE/i.test(s);

  // sqlite rowid-based dedup → Postgres ctid self-join (keeps one row per group).
  s = s.replace(
    /DELETE\s+FROM\s+([A-Za-z0-9_]+)\s+WHERE\s+rowid\s+NOT\s+IN\s*\(\s*SELECT\s+MAX\(rowid\)\s+FROM\s+\1\s+GROUP\s+BY\s+([A-Za-z0-9_,\s]+?)\s*\)/gi,
    (_m, table, cols) => {
      const eq = cols
        .split(",")
        .map((c: string) => `a.${c.trim()} = b.${c.trim()}`)
        .join(" AND ");
      return `DELETE FROM ${table} a USING ${table} b WHERE ${eq} AND a.ctid < b.ctid`;
    },
  );

  // PRAGMA table_info(X) → information_schema (store reads `.name` and `.notnull`).
  s = s.replace(
    /PRAGMA\s+table_info\(\s*([A-Za-z0-9_]+)\s*\)/gi,
    (_m, table) =>
      `SELECT column_name AS name, CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull, data_type AS type ` +
      `FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`,
  );

  // sqlite_master listing of tables + indexes (used to find legacy multica_* objects).
  s = s.replace(
    /SELECT\s+name\s*,\s*type\s+FROM\s+sqlite_master\s+WHERE\s+type\s+IN\s*\(\s*'table'\s*,\s*'index'\s*\)/gi,
    `SELECT tablename AS name, 'table' AS type FROM pg_tables WHERE schemaname='public' ` +
      `UNION ALL SELECT indexname AS name, 'index' AS type FROM pg_indexes WHERE schemaname='public'`,
  );

  // sqlite_master CREATE-text lookup → return NULL (regex checks become false on fresh PG).
  s = s.replace(
    /SELECT\s+sql\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s*=\s*'([A-Za-z0-9_]+)'/gi,
    (_m, table) =>
      `SELECT NULL::text AS sql FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}'`,
  );

  // INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING.
  s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");

  // ALTER TABLE … ADD COLUMN → idempotent (PG errors on an existing column otherwise).
  s = s.replace(
    /ALTER\s+TABLE\s+("?[A-Za-z0-9_]+"?)\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi,
    "ALTER TABLE $1 ADD COLUMN IF NOT EXISTS ",
  );

  // `ON CONFLICT(col)` → `ON CONFLICT (col)`.
  s = s.replace(/ON\s+CONFLICT\(/gi, "ON CONFLICT (");

  // Strip FOREIGN KEY clauses. sqlite runs with foreign_keys OFF (they are not
  // enforced), so they are decorative; Postgres would reject them at CREATE time
  // for forward-referenced tables. Removing them keeps behavior identical.
  if (/FOREIGN\s+KEY/i.test(s)) {
    s = s.replace(
      /FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+[A-Za-z0-9_]+\s*\([^)]*\)(\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT))*/gi,
      "",
    );
    s = s.replace(/,(\s*,)+/g, ",").replace(/\(\s*,/g, "(").replace(/,\s*\)/g, ")");
  }

  if (hadInsertOrIgnore && !/ON\s+CONFLICT/i.test(s)) {
    s = s.replace(/;\s*$/, "") + " ON CONFLICT DO NOTHING";
  }

  return numberPlaceholders(s);
}

/** Split a multi-statement DDL block on `;`, respecting strings and `--` comments. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      cur += ch;
      continue;
    }
    if (!inString && ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inString && ch === ";") {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function normalizeParams(args: unknown[]): unknown[] {
  let params = args;
  if (args.length === 1 && Array.isArray(args[0])) params = args[0] as unknown[];
  return params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
}

// ────────────────────────────── sync bridge ──────────────────────────────

const STATUS_PENDING = 0;
const STATUS_ERROR = 2;
const RESULT_BUFFER_BYTES = 64 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 60_000;

/**
 * Raised when a single statement's reply exceeds the bridge limit (MUL-386 C.1).
 *
 * Its message is deliberately self-contained: `PgBridge.exec` must NOT append the
 * SQL text it adds to every other failure, because this error can surface through
 * a route handler's `c.json({ error: message })` and would then leak SQL into an
 * HTTP response body.
 */
export class PostgresReplyTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(
      `postgres reply of ${bytes} bytes exceeds ${maxBytes} bytes bridge limit; `
      + "paginate or project columns",
    );
    this.name = "PostgresReplyTooLargeError";
  }
}

/**
 * Resolved lazily and cached: the check runs on every SQL round trip, and
 * `process.env` lookups are not free on that path. Tests that change the limit
 * call `resetDbReplyLimitForTest`.
 */
let cachedReplyMaxBytes: number | null = null;

function dbReplyMaxBytes(): number {
  if (cachedReplyMaxBytes === null) cachedReplyMaxBytes = resolveDbReplyMaxBytes();
  return cachedReplyMaxBytes;
}

/** Test seam: drop the cached limit so the next query re-reads the environment. */
export function resetDbReplyLimitForTest(): void {
  cachedReplyMaxBytes = null;
}

class PgBridge {
  private readonly control = new SharedArrayBuffer(16);
  private readonly data = new SharedArrayBuffer(RESULT_BUFFER_BYTES);
  private readonly ctl = new Int32Array(this.control);
  private readonly buf = new Uint8Array(this.data);
  private readonly worker: Worker;

  constructor(url: string) {
    this.worker = new Worker(new URL("./pg-worker.ts", import.meta.url).href);
    this.request({ init: url });
  }

  private request(msg: { init?: string; sql?: string; params?: unknown[] }): any {
    Atomics.store(this.ctl, 0, STATUS_PENDING);
    this.worker.postMessage({ control: this.control, data: this.data, ...msg });
    // MUL-367: measure only real SQL. `init` opens the connection, so counting it
    // would invent one query per process and inflate the first request's numbers.
    const measured = msg.sql !== undefined;
    const startedAt = measured ? performance.now() : 0;
    let waitRecorded = false;
    try {
      const waited = Atomics.wait(this.ctl, 0, STATUS_PENDING, QUERY_TIMEOUT_MS);
      if (waited === "timed-out") throw new Error("postgres bridge timed out");
      const status = Atomics.load(this.ctl, 0);
      const len = Atomics.load(this.ctl, 1);
      // The reply is on the shared buffer by now, so its size is what crossed the
      // bridge for this statement.
      if (measured) {
        recordDbQuery(performance.now() - startedAt, len);
        waitRecorded = true;
      }
      // MUL-386 C.1 guardrails. Both run BEFORE decode/parse: the point of the
      // hard limit is to refuse the payload before the main thread pays the
      // TextDecoder + JSON.parse cost, and the warning line exists so the size is
      // visible in logs without turning the request into a failure.
      if (measured) {
        const limit = dbReplyMaxBytes();
        if (limit > 0 && len > limit) {
          emitDbReplyRejected(len, limit);
          throw new PostgresReplyTooLargeError(len, limit);
        }
        emitLargeDbReply(len);
      }
      const parseStartedAt = performance.now();
      try {
        const obj = JSON.parse(new TextDecoder().decode(this.buf.slice(0, len)));
        if (status === STATUS_ERROR || obj.error) throw new Error(`postgres: ${obj.error}`);
        return obj;
      } finally {
        // Main-thread decode + parse is a separate cost from waiting on Postgres;
        // it is the measurable half of the MUL-366 "serialization + GC" hypothesis.
        if (measured) recordDbParse(performance.now() - parseStartedAt);
      }
    } finally {
      // A timed-out statement still spent the whole timeout blocked on the bridge.
      // Counting it keeps a stuck database visible as busy time instead of letting
      // the request look fast.
      if (measured && !waitRecorded) recordDbQuery(performance.now() - startedAt, 0);
    }
  }

  exec(sql: string, params: unknown[]): { rows: any[]; count: number } {
    try {
      const r = this.request({ sql, params });
      return { rows: r.rows ?? [], count: r.count ?? 0 };
    } catch (err) {
      // The size guardrail's message is user-facing: route handlers answer with
      // `c.json({ error: message })`, so appending SQL here would leak schema
      // details into an HTTP response body.
      if (err instanceof PostgresReplyTooLargeError) throw err;
      throw new Error(`${(err as Error).message}\n  SQL: ${sql.slice(0, 400)}`);
    }
  }

  close(): void {
    this.worker.terminate();
  }
}

class PgStatement implements SqlStatement {
  constructor(private readonly bridge: PgBridge, private readonly sql: string) {}
  get(...params: unknown[]): any {
    return this.bridge.exec(this.sql, normalizeParams(params)).rows[0] ?? null;
  }
  all(...params: unknown[]): any[] {
    return this.bridge.exec(this.sql, normalizeParams(params)).rows;
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return { changes: this.bridge.exec(this.sql, normalizeParams(params)).count, lastInsertRowid: 0 };
  }
  values(...params: unknown[]): any[][] {
    return this.bridge.exec(this.sql, normalizeParams(params)).rows.map((r) => Object.values(r));
  }
}

export class PostgresSyncDatabase implements SqlDatabase {
  private readonly bridge: PgBridge;
  private transactionDepth = 0;
  constructor(url: string) {
    this.bridge = new PgBridge(url);
  }
  /** True while a `transaction()` callback runs; its writes are not committed yet. */
  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }
  query(sql: string): SqlStatement {
    return new PgStatement(this.bridge, translateSqliteToPg(sql));
  }
  prepare(sql: string): SqlStatement {
    return this.query(sql);
  }
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return { changes: this.bridge.exec(translateSqliteToPg(sql), normalizeParams(params)).count, lastInsertRowid: 0 };
  }
  exec(sql: string): void {
    for (const stmt of splitStatements(sql)) {
      const translated = translateSqliteToPg(stmt);
      if (translated.trim()) this.bridge.exec(translated, []);
    }
  }
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]): T => {
      this.bridge.exec("BEGIN", []);
      this.transactionDepth += 1;
      try {
        const result = fn(...args);
        this.bridge.exec("COMMIT", []);
        return result;
      } catch (err) {
        try {
          this.bridge.exec("ROLLBACK", []);
        } catch {
          // connection already aborted the transaction
        }
        throw err;
      } finally {
        this.transactionDepth -= 1;
      }
    };
  }
  close(): void {
    this.bridge.close();
  }
}

/** True when a Postgres backend is configured. */
export function isPostgresConfigured(): boolean {
  return /^postgres(ql)?:\/\//i.test(process.env.MULTIREMI_DATABASE_URL?.trim() ?? "");
}

/** Open the configured Multiremi database: Postgres if MULTIREMI_DATABASE_URL is set, else shared sqlite. */
export function openMultiremiDatabase(): SqlDatabase {
  const url = process.env.MULTIREMI_DATABASE_URL?.trim();
  if (url && isPostgresConfigured()) return new PostgresSyncDatabase(url);
  return getDb() as unknown as SqlDatabase;
}
