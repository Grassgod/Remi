import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
test("introspect", () => {
  const d = new Database(":memory:");
  runMigrations(d as unknown as SqlDatabase);
  console.log("cols", JSON.stringify(d.query("PRAGMA table_info(multiremi_session_archives)").all()));
  console.log("idx", JSON.stringify(d.query("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='multiremi_session_archives'").all()));
  console.log("ddl", JSON.stringify((d.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='multiremi_session_archives'").get() as any).sql));
  d.close();
});
