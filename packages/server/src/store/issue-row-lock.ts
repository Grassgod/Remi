import type { SqlDatabase } from "./db/postgres.js";

/** Caller owns the transaction. SQLite serializes writers; PG locks this row. */
export function lockIssueRowWithinTransaction(database: SqlDatabase, issueId: string): boolean {
  return database.run("UPDATE multiremi_issues SET id = id WHERE id = ?", [issueId]).changes > 0;
}
