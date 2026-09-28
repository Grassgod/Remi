import type { SqlDatabase } from "./db/postgres.js";

/** Caller owns the transaction. SQLite serializes writers; PG locks this row. */
export function lockIssueRowWithinTransaction(database: SqlDatabase, issueId: string): boolean {
  return database.run("UPDATE multiremi_issues SET id = id WHERE id = ?", [issueId]).changes > 0;
}

/**
 * ADR 0003 #8: every Issue row the transaction needs, once, in ascending id
 * order, after any workspace lock. Never lock another Issue row afterwards.
 * Keys are the locked set, values whether the row exists.
 */
export function lockIssueRowsWithinTransaction(
  database: SqlDatabase,
  ids: Array<string | null | undefined>,
): Map<string, boolean> {
  const ordered = [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
  return new Map(ordered.map((id) => [id, lockIssueRowWithinTransaction(database, id)]));
}
