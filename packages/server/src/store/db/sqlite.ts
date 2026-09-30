import { Database } from "bun:sqlite";

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

/** Restoring a serialized backup creates a handle just as opening a file does. */
export function deserializeSqliteDatabase(
  ...args: Parameters<typeof Database.deserialize>
): Database & { readonly dialect: "sqlite" } {
  return markSqliteDialect(Database.deserialize(...args));
}
