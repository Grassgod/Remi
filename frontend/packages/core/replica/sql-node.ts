/**
 * A {@link SqlDatabase} over `node:sqlite`, for the unit tests.
 *
 * The production engine runs on `sqlite-wasm` over `opfs-sahpool`; that is the
 * only SQLite a browser has. Testing the same statements against `node:sqlite`
 * keeps the schema, the coverage merge and the patch path under a fast test
 * instead of a browser-only one, and the two drivers agree on everything the
 * replica uses (prepared statements, `ON CONFLICT`, 64-bit integers).
 *
 * Deliberately not imported by anything the browser bundles.
 */

import type { SqlDatabase, SqlStatement, SqlValue } from "./sql";

/** The subset of `node:sqlite`'s `DatabaseSync` this adapter binds to. */
export interface NodeSqlStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
}

export interface NodeSqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NodeSqlStatement;
  close(): unknown;
}

/**
 * Wrap `node:sqlite`.
 *
 * No empty-parameter special case here on purpose: `node:sqlite` accepts a
 * zero-argument `run()`/`all()`/`get()`, and the wasm adapter is the one that has
 * to skip the call. A test against this driver therefore cannot catch that
 * difference — the browser suite does, which is why the check runs in both
 * places.
 *
 * `node:sqlite` returns null-prototype objects, which the callers read by field
 * name only; no row is ever spread into a class instance, so no prototype
 * copying is needed here.
 */
export function nodeSqlDatabase(db: NodeSqlDatabase): SqlDatabase {
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => {
      const statement = db.prepare(sql);
      const adapter: SqlStatement = {
        run: (params) => {
          statement.run(...params);
        },
        all: <T,>(params: readonly SqlValue[]) => statement.all(...params) as T[],
        get: <T,>(params: readonly SqlValue[]) => (statement.get(...params) ?? null) as T | null,
        finalize: () => {
          // `node:sqlite` finalizes statements with the database handle.
        },
      };
      return adapter;
    },
    close: () => {
      db.close();
    },
  };
}
