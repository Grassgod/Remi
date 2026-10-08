import { afterEach, expect, it, spyOn } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { assertDayModelPagination, assertDefaultDetailPage } from "./usage-day-model-cases.js";
afterEach(resetMultiremiTestEnv);
it("projects bounded date × model groups from canonical facts and binds cursors on SQLite", () => {
  const store = createLocalStore();
  const original = db!.query.bind(db!), sql: string[] = [];
  const query = spyOn(db!, "query").mockImplementation(text => { if (text.startsWith("WITH tasks")) sql.push(text); return original(text); });
  try { assertDayModelPagination(store, "day-model-sqlite"); } finally { query.mockRestore(); }
  expect(sql[0]).not.toContain("detail_groups");
  expect(sql.some(text => text.includes("detail_keys AS MATERIALIZED") && text.includes("LIMIT 3") && text.includes("detail_facts AS MATERIALIZED"))).toBe(true);
  expect(sql.every(text => !text.includes("t.usage") && !text.includes("SELECT *"))).toBe(true);
});
it("returns at most the default 200 joint groups and continues without duplicates on SQLite", () => assertDefaultDetailPage(createLocalStore(), "page-budget-sqlite"));
