/**
 * The SQLite seam and the `sqlite-wasm` adapter.
 *
 * Two engines run the same statements: the Worker uses the official
 * `sqlite-wasm` build over `opfs-sahpool`, and the unit tests use `node:sqlite`.
 * Neither driver reaches the protocol: `sql-store.ts` speaks this interface, so
 * the SQL production executes is the SQL a fast unit test executes.
 *
 * The interface is deliberately synchronous because `opfs-sahpool`'s whole point
 * is synchronous access handles; keeping it off the page's main thread is the
 * Worker's job, not the statement's.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  /** Bind and execute; no rows returned. */
  run(params: readonly SqlValue[]): void;
  /** Execute and return every row. */
  all<T = Record<string, SqlValue>>(params: readonly SqlValue[]): T[];
  /** Execute and return the first row, or null. */
  get<T = Record<string, SqlValue>>(params: readonly SqlValue[]): T | null;
  finalize(): void;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/**
 * The `sqlite-wasm` statement surface this adapter binds to.
 *
 * Declared structurally rather than imported, so the module stays loadable
 * without the wasm build (the unit tests import the protocol, not the engine's
 * browser half) — the same reason the package's own types are not a dependency
 * of the pure modules.
 */
export interface WasmStatement {
  bind(params: readonly SqlValue[]): unknown;
  step(): boolean;
  get(row: object): Record<string, SqlValue>;
  reset(alsoClearBinds?: boolean): unknown;
  finalize(): unknown;
}

export interface WasmDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): WasmStatement;
  close(): unknown;
}

/**
 * Wrap a `sqlite-wasm` `oo1.DB` in {@link SqlDatabase}.
 *
 * Statements are prepared per call and finalized immediately rather than cached:
 * the Worker writes in batches (a reconnect backfill is one loop), and a
 * statement cache would have to be invalidated on every whole-database clear for
 * no measurable gain at this call volume.
 */
export function wasmSqlDatabase(db: WasmDatabase): SqlDatabase {
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (params) => {
          statement.bind(params);
          statement.step();
          statement.reset(true);
        },
        all: <T,>(params: readonly SqlValue[]) => {
          const rows: unknown[] = [];
          statement.bind(params);
          while (statement.step()) rows.push(statement.get({}));
          statement.reset(true);
          return rows as T[];
        },
        get: <T,>(params: readonly SqlValue[]) => {
          statement.bind(params);
          const hasRow = statement.step();
          const row = hasRow ? statement.get({}) : null;
          statement.reset(true);
          return row as T | null;
        },
        finalize: () => {
          statement.finalize();
        },
      };
    },
    close: () => {
      db.close();
    },
  };
}
