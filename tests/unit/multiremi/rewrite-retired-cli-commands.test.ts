import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { executeRewrite, main, printRewritePlan, rewriteText, scanRewriteCandidates } from "../../../scripts/migrations/rewrite-retired-cli-commands.js";

const dbs: Array<ReturnType<typeof openSqliteDatabase>> = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture(path = ":memory:"): SqlDatabase {
  const db = openSqliteDatabase(path); dbs.push(db);
  db.exec(`
    CREATE TABLE multiremi_workspaces (id TEXT PRIMARY KEY, settings TEXT, updated_at TEXT);
    CREATE TABLE multiremi_agents (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, instructions TEXT, updated_at TEXT);
    CREATE TABLE multiremi_squads (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, instructions TEXT, updated_at TEXT);
    CREATE TABLE multiremi_system_events (id TEXT PRIMARY KEY, workspace_id TEXT, resource TEXT, event TEXT, resource_id TEXT, payload TEXT, status TEXT, available_at TEXT, created_at TEXT, processed_at TEXT);
  `);
  const sql = db as unknown as SqlDatabase;
  sql.run("INSERT INTO multiremi_workspaces VALUES ('local', ?, 'v1')", [JSON.stringify({ prompt_bootstrap_appendix: "读箱：`remi inbox list --limit 10`。\n按单看轮：`remi issue runs MUL-508`。", prompt_revision: 7, other: "keep" })]);
  sql.run("INSERT INTO multiremi_agents VALUES ('agt_1', 'Worker', 'local', ?, 'v1')", ["Expand with `remi session log get ises_1 3`.\n`remi task prompt tsk_attempt`"]);
  sql.run("INSERT INTO multiremi_agents VALUES ('agt_noop', 'Noop', 'local', 'Nothing to rewrite', 'v1')");
  for (const name of ["Remi", "Remi-CC"]) sql.run("INSERT INTO multiremi_agents VALUES (?, ?, 'local', 'remi task list', 'v1')", [name, name]);
  sql.run("INSERT INTO multiremi_squads VALUES ('sqd_1', 'Team', 'local', ?, 'v1')", ["`remi issue comment add MUL-508 --content hello`"]);
  return sql;
}
function snapshot(db: SqlDatabase) {
  return JSON.stringify(["multiremi_workspaces", "multiremi_agents", "multiremi_squads", "multiremi_system_events"].map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`).all()));
}
describe("operator retired-command rewrites", () => {
  it("suggests complete templates without treating old seq or attempt ids as new ids", () => {
    expect(rewriteText("`remi issue runs MUL-508`")).toBe("`remi turn list --issue <issue>`");
    expect(rewriteText("`remi session log get ises_1 3`")).toBe("`remi message get <message>`");
    expect(rewriteText("`remi task prompt tsk_attempt`")).toBe("`remi turn get <turn> --input`");
    expect(rewriteText("`remi issue comment add MUL-508 --content hello`")).toBe("`remi message send <conversation>`");
    expect(rewriteText("  remi task redispatch tsk_1 --yes")).toBe("  remi turn retry <turn> --cold");
    expect(rewriteText("使用 remi task list 看轮")).toBe("使用 remi turn list 看轮");
    expect(rewriteText("remi task listing")).toBe("remi task listing");
    expect(rewriteText("some_task list")).toBe("some_task list");
    expect(() => rewriteText("Use remi task prompt tsk_1 to read")).toThrow("Ambiguous");
  });
  it("prints every changed line with entity, field, original and suggestion while scanning writes nothing", () => {
    const db = fixture(), before = snapshot(db);
    const candidates = scanRewriteCandidates(db), lines: string[] = [];
    expect(candidates.map((candidate) => candidate.entity)).toEqual(["workspace", "agent", "squad"]);
    printRewritePlan(candidates, (line) => lines.push(line));
    expect(lines.length).toBe(5);
    for (const line of lines) {
      const row = JSON.parse(line);
      expect(Object.keys(row)).toEqual(["实体", "字段", "原句", "建议替换"]);
      expect(row["原句"]).not.toBe(row["建议替换"]);
    }
    expect(snapshot(db)).toBe(before);
    expect(scanRewriteCandidates(db)).toEqual(candidates);
  });
  it("executes with a revision and whole-value CAS, preserves unrelated settings and records hashed activity", () => {
    const db = fixture(), candidates = scanRewriteCandidates(db);
    for (const candidate of candidates) executeRewrite(db, candidate, "operator_fixture", "v2");
    const workspace = db.query("SELECT settings, updated_at FROM multiremi_workspaces WHERE id='local'").get() as { settings: string; updated_at: string };
    expect(JSON.parse(workspace.settings)).toMatchObject({ prompt_revision: 8, other: "keep", prompt_updated_by: "operator_fixture" });
    expect(workspace.updated_at).toBe("v2");
    const activities = db.query("SELECT * FROM multiremi_system_events ORDER BY resource").all() as Array<{ payload: string; status: string; event: string }>;
    expect(activities.length).toBe(3);
    for (const activity of activities) {
      expect(activity.event).toBe("retired_cli_commands_rewritten");
      expect(activity.status).toBe("processed");
      expect(JSON.parse(activity.payload)).toMatchObject({ actor_id: "operator_fixture", expected_version: "v1" });
      expect(JSON.parse(activity.payload).before_sha256).toHaveLength(64);
      expect(activity.payload).not.toContain("remi");
    }
    expect(scanRewriteCandidates(db)).toEqual([]);
    expect(db.query("SELECT instructions FROM multiremi_agents WHERE id='Remi'").get()).toEqual({ instructions: "remi task list" });
  });
  for (const entity of ["workspace", "agent", "squad"] as const) it(`${entity}: preserves concurrent changes and records no success on conflict`, () => {
    const db = fixture(), candidate = scanRewriteCandidates(db).find((row) => row.entity === entity)!;
    if (entity === "workspace") db.run("UPDATE multiremi_workspaces SET settings=? WHERE id='local'", [JSON.stringify({ prompt_revision: 8, prompt_bootstrap_appendix: "Concurrent human edit" })]);
    else db.run(`UPDATE multiremi_${entity === "agent" ? "agents" : "squads"} SET instructions='Concurrent human edit' WHERE id=?`, [candidate.id]);
    const before = snapshot(db);
    expect(() => executeRewrite(db, candidate, "operator_fixture", "v2")).toThrow("rewrite_conflict");
    expect(snapshot(db)).toBe(before);
  });
  it("runs dry-run against an existing read-only database with zero updates or activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retired-rewrite-")), path = join(dir, "fixture.db");
    const db = fixture(path), before = snapshot(db), log = console.log, output: string[] = [];
    console.log = (...values) => output.push(values.join(" "));
    try {
      await main(["--dry-run", "--sqlite", path]);
      expect(output.at(-1)).toBe("dry-run: 3 entities; 0 writes");
      expect(output.slice(0, -1).length).toBe(5);
      expect(snapshot(db)).toBe(before);
      await expect(main(["--execute", "--dry-run", "--sqlite", path])).rejects.toThrow("Choose exactly one");
      await expect(main(["--dry-run", "--sqlite"])).rejects.toThrow("Invalid argument");
      await expect(main(["--dry-run", "--unknown"])).rejects.toThrow("Invalid argument");
    } finally { console.log = log; db.close(); dbs.splice(dbs.indexOf(db as never), 1); await rm(dir, { recursive: true, force: true }); }
  });
});
