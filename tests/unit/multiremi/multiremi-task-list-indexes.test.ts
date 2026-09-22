import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

/**
 * MUL-357: the global task list pages with `ORDER BY created_at DESC, id DESC`,
 * optionally constrained by status. Without the matching indexes every page
 * sorts the whole table, so these assert both that the migration creates them
 * and that the planner actually chooses them for the statements the route runs.
 */
afterEach(resetMultiremiTestEnv);

function indexSql(name: string): string | null {
  const row = db!.query(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(name) as { sql: string | null } | null;
  return row?.sql ?? null;
}

function plan(sql: string, params: string[] = []): string {
  const rows = db!.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join("; ");
}

describe("Task list pagination indexes", () => {
  it("creates the created_at and status+created_at indexes and records the migration", () => {
    createStore();
    expect(indexSql("idx_multiremi_tasks_created_at")).toContain("created_at DESC, id DESC");
    expect(indexSql("idx_multiremi_tasks_status_created")).toContain("status, created_at DESC, id DESC");
    const applied = db!.query(
      "SELECT id FROM multiremi_schema_migrations WHERE id = '20260921_task_list_pagination_indexes'",
    ).all();
    expect(applied).toHaveLength(1);
  });

  it("plans the unfiltered page and the status-filtered page through those indexes", () => {
    createStore();
    const page = "SELECT * FROM multiremi_tasks WHERE 1 = 1%s ORDER BY created_at DESC, id DESC LIMIT 200";
    expect(plan(page.replace("%s", "")))
      .toContain("idx_multiremi_tasks_created_at");
    expect(plan(page.replace("%s", " AND status = ?"), ["completed"]))
      .toContain("idx_multiremi_tasks_status_created");
  });
});
