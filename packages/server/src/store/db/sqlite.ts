import { Database } from "bun:sqlite";
import type { SqlDatabase, SqlDatabaseDialect } from "./postgres.js";

/** Attach the dialect without replacing the handle, wrapper, or proxy. */
export function markSqliteDialect<T extends object>(db: T): T & { readonly dialect: "sqlite" } {
  return Object.assign(db, { dialect: "sqlite" as const });
}

export function openSqliteDatabase(
  filename = ":memory:",
  options?: ConstructorParameters<typeof Database>[1],
): Database & { readonly dialect: "sqlite" } {
  return markSqliteDialect(new Database(filename, options));
}

/**
 * Schema migrations rename tables while foreign keys are off and rely on SQLite
 * rewriting other tables' REFERENCES to follow the rename. That only happens
 * with `legacy_alter_table` off: Bun's bundled Linux SQLite and Homebrew default
 * it off, Apple's system SQLite defaults it on. Pin the behaviour CI exercises.
 */
export function withModernSqliteAlterTable<T>(db: SqlDatabase, dialect: SqlDatabaseDialect | undefined, fn: () => T): T {
  if (dialect !== "sqlite" || !Number(db.query("PRAGMA legacy_alter_table").get()?.legacy_alter_table)) return fn();
  db.exec("PRAGMA legacy_alter_table=OFF");
  try { return fn(); } finally { db.exec("PRAGMA legacy_alter_table=ON"); }
}

/** Restoring a serialized backup creates a handle just as opening a file does. */
export function deserializeSqliteDatabase(
  ...args: Parameters<typeof Database.deserialize>
): Database & { readonly dialect: "sqlite" } {
  return markSqliteDialect(Database.deserialize(...args));
}
