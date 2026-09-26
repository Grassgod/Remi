import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request memoization of short-lived, read-mostly rows.
 *
 * One daemon heartbeat reads the same Runtime row, the same SSH-Mesh workspace row and the same
 * workspace/membership/relay rows several times over — once in the auth guard, once inside the
 * store's heartbeat, once again when the route assembles the response. Measured on the local
 * fixture, a single worst-case heartbeat issued the Runtime row query six times and the
 * workspace-scoped reads two to five times each (MUL-389).
 *
 * Another connection can still change those rows mid-request: the first read happens before the
 * request takes any lock. So a transaction — where the store takes the lock that orders it against
 * those writers — never sees a row cached before it began; see {@link invalidatingDatabase}.
 *
 * The cache is deliberately narrow rather than a general query cache:
 *
 * - it only ever holds rows the caller asks it to hold, so the blast radius is the handful of
 *   helpers that opt in;
 * - it is **disabled by default** and is switched on by the HTTP entry point for one request, so
 *   background jobs, CLI commands, tests and any store used without a server keep reading
 *   straight from the database;
 * - writes performed through the store invalidate the rows of the table they wrote
 *   (`invalidateTable`), so a write inside the scope can never be followed by a stale read of the
 *   rows it changed, while unrelated cached rows survive for the rest of the request;
 * - inside a transaction only rows read since that transaction began are served. They stay cached
 *   after it commits, so the rest of the request sees the rows as they were under the lock; a
 *   transaction that fails (including at COMMIT) clears the cache, which may hold its uncommitted
 *   rows.
 *
 * Outside a transaction a cached row can be as old as the start of the request. That is the same
 * window as reading a row once and using it for the rest of the request, which is what the store
 * did before the cache.
 */
export interface RequestReadCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  /** Drop everything. */
  clear(): void;
  /** Drop the entries read from one table. */
  clearTable(table: string): void;
  readonly size: number;
}

const storage = new AsyncLocalStorage<MapReadCache>();

class MapReadCache implements RequestReadCache {
  /** `generation` is the transaction an entry was stored in; bumped as each outermost one begins. */
  private readonly entries = new Map<string, { value: unknown; generation: number }>();
  private generation = 0;
  private transactionDepth = 0;
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.transactionDepth > 0 && entry.generation !== this.generation) return undefined;
    return entry.value as T;
  }
  enterTransaction(): void {
    if (this.transactionDepth === 0) this.generation += 1;
    this.transactionDepth += 1;
  }
  leaveTransaction(committed: boolean): void {
    this.transactionDepth -= 1;
    if (!committed) this.entries.clear();
  }
  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, generation: this.generation });
  }
  clear(): void {
    this.entries.clear();
  }
  clearTable(table: string): void {
    const prefix = `${table}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Replace one cached value with a value the caller just wrote.
 *
 * The write-through counterpart of {@link invalidatingDatabase}: a store method that performs an
 * UPDATE knows the new row, so it can hand it to the cache instead of letting the write evict the
 * entry and forcing the next reader to re-select the row it just wrote. That is not a stale read —
 * the value came from the write itself. No-op outside a scope.
 */
export function writeThroughRequestReadCache<T>(key: string, value: T): void {
  storage.getStore()?.set(key, value);
}

/** The cache bound to the current async scope, or null when no scope is active. */
export function activeRequestReadCache(): RequestReadCache | null {
  return storage.getStore() ?? null;
}

/** Run `fn` with a fresh per-request cache active. Nested calls reuse the outer scope's cache. */
export function withRequestReadCache<T>(fn: () => T): T {
  if (storage.getStore()) return fn();
  return storage.run(new MapReadCache(), fn);
}

/** Forget everything cached in the current scope. No-op outside a scope. */
export function invalidateRequestReadCache(): void {
  storage.getStore()?.clear();
}

// ────────────────────────────── write invalidation ──────────────────────────────

/** Statements that only read. Anything else is treated as a write. */
const READ_ONLY_STATEMENT = /^\s*(?:SELECT|PRAGMA|EXPLAIN|WITH\s+[\s\S]*?SELECT)\b/i;

/**
 * `UPDATE t …`, `INSERT INTO t …`, `DELETE FROM t …` → `t`.
 *
 * Returns null when the target table cannot be identified, which makes the caller drop the whole
 * cache instead of guessing. Every SQL string reaching this module is generated by the store, not
 * by callers, so the shapes are the ones the repos emit.
 */
function writtenTable(sql: string): string | null {
  const match = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_$]*)/i.exec(sql);
  return match ? match[1]! : null;
}

/**
 * Wrap a `SqlDatabase` so writes invalidate exactly the cached rows they can change, and a
 * transaction never reads a row cached before it began.
 *
 * Each cache entry is keyed `<table>\0<rest>` by {@link cacheKey}; a write clears the entries of
 * the table it wrote and leaves every other table's entries alone. That precision is what lets a
 * heartbeat cache its SSH-Mesh configuration while writing that daemon's own state row. A write
 * whose table cannot be identified clears everything.
 *
 * Transactions are where the store takes its locks and re-reads rows under them (the heartbeat
 * re-reads its Runtime row after the workspace lifecycle lock, so a Runtime deleted meanwhile is
 * reported gone). Serving that re-read from a row cached before the lock would undo the lock.
 * Rows the transaction itself read are served, which relies on the store's rule that a
 * transaction takes its lock before it reads what the lock protects.
 */
export function invalidatingDatabase<T extends object>(database: T): T {
  const interceptStatement = (statement: unknown, sql: string): unknown => {
    if (READ_ONLY_STATEMENT.test(sql)) return statement;
    const table = writtenTable(sql);
    return new Proxy(statement as object, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          invalidateTable(table);
          return value.apply(target, args);
        };
      },
    });
  };
  return new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if ((key === "query" || key === "prepare") && typeof value === "function") {
        return (sql: string, ...args: unknown[]) =>
          interceptStatement(value.apply(target, [sql, ...args]), String(sql));
      }
      if ((key === "run" || key === "exec") && typeof value === "function") {
        return (sql: string, ...args: unknown[]) => {
          if (!READ_ONLY_STATEMENT.test(String(sql))) invalidateTable(writtenTable(String(sql)));
          return value.apply(target, [sql, ...args]);
        };
      }
      if (key === "transaction" && typeof value === "function") {
        return (fn: (...args: unknown[]) => unknown) => {
          const runTransaction = value.apply(target, [fn]) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => withinTransaction(() => runTransaction(...args));
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

/** Run a whole transaction, BEGIN to COMMIT, as a new cache generation. */
function withinTransaction<T>(runTransaction: () => T): T {
  const cache = storage.getStore();
  if (!cache) return runTransaction();
  cache.enterTransaction();
  let committed = false;
  try {
    const result = runTransaction();
    committed = true;
    return result;
  } finally {
    cache.leaveTransaction(committed);
  }
}

function invalidateTable(table: string | null): void {
  const cache = storage.getStore();
  if (!cache) return;
  if (!table) {
    cache.clear();
    return;
  }
  cache.clearTable(table);
}

/** Namespaced cache key. `table` is the table the value was read from, so writes can target it. */
export function cacheKey(table: string, ...parts: Array<string | number | null>): string {
  return [table, ...parts.map((part) => String(part ?? ""))].join("\u0000");
}
