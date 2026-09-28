import { describe, expect, it } from "bun:test";
import { classifyLockOrderStatement, type LockOrderClass } from "@multiremi/store/lock-order-sentinel.js";

const cases: Array<[string, string, LockOrderClass[]]> = [
  ["ordinary SELECT", "SELECT id FROM multiremi_issues", []],
  ["ordinary WITH SELECT", "WITH i AS (SELECT * FROM multiremi_issues) SELECT * FROM i", []],
  ["read snapshot characteristics", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", []],
  ["empty SQL", " \n ", []],
  ["workspace lifecycle UPDATE", "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?", ["W"]],
  ["domain UPDATE", "UPDATE multiremi_issues SET id = id WHERE id = ?", ["D"]],
  ["workspace data UPDATE keeps the existing D rule", "UPDATE multiremi_workspaces SET name = ? WHERE id = ?", ["D"]],
  ["domain INSERT", "INSERT INTO multiremi_issues (id) VALUES (?)", ["D"]],
  ["domain DELETE", "DELETE FROM multiremi_issues WHERE id = ?", ["D"]],
  ["mixed case and newline", "sElEcT id\nFrOm multiremi_issues\nFoR\nNo KeY\nUpDaTe", ["D"]],
  ["quoted schema and table", 'SELECT id FROM "public"."multiremi_workspaces" FOR UPDATE', ["W"]],
  ["unquoted schema", "SELECT id FROM public.multiremi_issues FOR UPDATE", ["D"]],
  ["FROM and JOIN without OF", "SELECT i.id FROM multiremi_workspaces w JOIN multiremi_issues i ON i.workspace_id = w.id FOR UPDATE", ["W", "D"]],
  ["comma sources without OF", "SELECT i.id FROM multiremi_workspaces w, multiremi_issues i FOR SHARE", ["W", "D"]],
  ["OF domain alias only", "SELECT i.id FROM multiremi_workspaces w JOIN multiremi_issues i ON i.workspace_id = w.id FOR UPDATE OF i", ["D"]],
  ["OF workspace alias only", "SELECT i.id FROM multiremi_issues i JOIN multiremi_workspaces w ON w.id = i.workspace_id FOR UPDATE OF w", ["W"]],
  ["OF unaliased table", "SELECT id FROM multiremi_workspaces FOR KEY SHARE OF multiremi_workspaces", ["W"]],
  ["OF list", "SELECT i.id FROM multiremi_workspaces w JOIN multiremi_issues i ON i.workspace_id = w.id FOR UPDATE OF w, i NOWAIT", ["W", "D"]],
  ["multiple locking clauses", "SELECT i.id FROM multiremi_workspaces w JOIN multiremi_issues i ON i.workspace_id = w.id FOR SHARE OF w FOR UPDATE OF i SKIP LOCKED", ["W", "D"]],
  ["quoted alias", 'SELECT "Issue".id FROM multiremi_issues AS "Issue" FOR UPDATE OF "Issue"', ["D"]],
  ["quoted keyword alias", 'SELECT "where".id FROM multiremi_workspaces AS "where" FOR UPDATE OF "where"', ["W"]],
  ["ONLY source", "SELECT id FROM ONLY multiremi_workspaces FOR UPDATE", ["W"]],
  ["parenthesized joined sources", "SELECT w.id FROM (multiremi_workspaces w JOIN multiremi_issues i ON w.id = i.workspace_id) FOR UPDATE", ["W", "D"]],
  ["OF alias within parenthesized join", "SELECT w.id FROM (multiremi_workspaces w JOIN multiremi_issues i ON w.id = i.workspace_id) FOR UPDATE OF i", ["D"]],
  ["subquery within parenthesized join", "SELECT w.id FROM ((SELECT id FROM multiremi_workspaces) w JOIN multiremi_issues i ON w.id = i.workspace_id) FOR UPDATE OF w", ["W"]],
  ["WITH followed by locking SELECT", "WITH ready AS (SELECT 1) SELECT id FROM multiremi_issues FOR UPDATE", ["D"]],
  ["CTE locks in its own scope", "WITH locked AS (SELECT id FROM multiremi_issues FOR UPDATE) SELECT * FROM locked", ["D"]],
  ["outer clause does not lock CTE rows", "WITH unlocked AS (SELECT id FROM multiremi_workspaces) SELECT * FROM unlocked FOR UPDATE", []],
  ["CTE column names and materialization", "WITH unlocked(id) AS NOT MATERIALIZED (SELECT id FROM multiremi_issues) SELECT id FROM multiremi_workspaces FOR UPDATE", ["W"]],
  ["CTE domain table is not locked by outer OF", "WITH unlocked AS (SELECT id FROM multiremi_issues) SELECT w.id FROM multiremi_workspaces w JOIN unlocked i ON i.id = w.id FOR UPDATE OF w", ["W"]],
  ["schema-qualified name bypasses CTE", "WITH multiremi_workspaces AS (SELECT 1) SELECT id FROM public.multiremi_workspaces FOR UPDATE", ["W"]],
  ["subquery locks propagated from FROM", "SELECT id FROM (SELECT id FROM multiremi_workspaces) AS w FOR UPDATE OF w", ["W"]],
  ["subquery has its own lock", "SELECT id FROM (SELECT id FROM multiremi_issues FOR UPDATE) AS i", ["D"]],
  ["scalar subquery stays outside outer locking scope", "SELECT (SELECT id FROM multiremi_issues LIMIT 1) FROM multiremi_workspaces FOR UPDATE", ["W"]],
  ["writable CTE is not a pure read", "WITH changed AS (UPDATE multiremi_issues SET id = id RETURNING id) SELECT id FROM changed", ["D"]],
  ["workspace lifecycle write in CTE keeps W", "WITH locked AS (UPDATE multiremi_workspaces SET updated_at = updated_at RETURNING id) SELECT id FROM locked", ["W"]],
  ["single-quoted clause is just text", "SELECT 'for update' FROM multiremi_issues", []],
  ["doubled quote in literal", "SELECT 'it''s FOR NO KEY UPDATE' FROM multiremi_issues", []],
  ["escaped string", "SELECT E'it\\'s FOR SHARE' FROM multiremi_issues", []],
  ["dollar-quoted string", "SELECT $$FOR KEY SHARE$$ FROM multiremi_issues", []],
  ["tagged dollar-quoted string", "SELECT $msg$FOR UPDATE; FROM multiremi_workspaces$msg$ FROM multiremi_issues", []],
  ["quoted identifier is not a clause", 'SELECT "for update" FROM multiremi_issues', []],
  ["line comment is not a clause", "SELECT id FROM multiremi_issues -- FOR UPDATE\n", []],
  ["nested block comment is not a clause", "SELECT id FROM multiremi_issues /* FOR UPDATE /* FOR SHARE */ */", []],
  ["comments between clause keywords", "SELECT id FROM multiremi_issues FOR /* lock */ NO KEY -- row\n UPDATE", ["D"]],
  ["workspace UPDATE text in a literal is not W", "SELECT 'UPDATE multiremi_workspaces SET updated_at = updated_at'", []],
  ["comment before workspace UPDATE", "/* setup */ UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?", ["W"]],
  ["multiple statements retain lock order", "SELECT 1; UPDATE multiremi_workspaces SET updated_at = updated_at; SELECT id FROM multiremi_issues FOR UPDATE", ["W", "D"]],
  ["EXPLAIN does not execute locking SELECT", "EXPLAIN SELECT id FROM multiremi_issues FOR UPDATE", []],
  ["SQLite PRAGMA remains read-only", "PRAGMA table_info(multiremi_issues)", []],
];

describe("MUL-405 shared lock-order SQL classifier", () => {
  for (const [label, sql, expected] of cases) {
    it(label, () => expect(classifyLockOrderStatement(sql)).toEqual(expected));
  }
  for (const mode of ["UPDATE", "NO KEY UPDATE", "SHARE", "KEY SHARE"]) {
    for (const wait of ["", " NOWAIT", " SKIP LOCKED"]) {
      it(`FOR ${mode}${wait} locks domain rows`, () => {
        expect(classifyLockOrderStatement(`SELECT id FROM multiremi_issues FOR ${mode}${wait}`)).toEqual(["D"]);
      });
      it(`FOR ${mode}${wait} locks workspace rows`, () => {
        expect(classifyLockOrderStatement(`SELECT id FROM multiremi_workspaces FOR ${mode}${wait}`)).toEqual(["W"]);
      });
    }
  }
});
