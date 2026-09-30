import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const root = "packages/server/src/store/repos";

function ownerName(node: ts.Node, ast: ts.SourceFile): string {
  let owner: ts.Node | undefined = node.parent;
  while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  return owner?.name?.getText(ast) ?? "";
}

it("Issue-keyed workspace SQL has an explicit ownership predicate or a locked lifecycle exception", () => {
  const unexpected: string[] = [];
  const found = new Set<string>();
  const rules: Record<string, RegExp> = {
    "issue-workspaces-repo.ts:get": /i\.workspace_id = iw\.workspace_id/,
    "issue-workspaces-repo.ts:abandon": /WHERE issue_id = \? AND workspace_id = \? AND runtime_id IS NULL/,
    // markCleaned re-reads get() under the Issue lifecycle lock before this UPDATE.
    "issue-workspaces-repo.ts:markCleanedWithinLifecycleLock": /SET status = 'cleaned'/,
    // Raw records must block moves even when their workspace is foreign (hidden).
    "issues-repo.ts:assertIssueWorkspaceMoveAllowed": /SELECT workspace_id, status, runtime_id/,
    "issues-repo.ts:issueDeletionBlockWithinLifecycleLock": /WHERE issue_id = \? AND workspace_id = \?/,
    "issues-repo.ts:updateIssueWithinTransaction": /WHERE issue_id = \? AND status = 'cleaned'/,
    // The hard-delete sweep follows global archive verification, not a content read.
    "issues-repo.ts:deleteIssueRowsWithinLifecycleLock": /DELETE FROM multiremi_issue_workspaces WHERE issue_id = \?/,
    "session-archives-repo.ts:withWritableIssueArchive": /iw\.workspace_id = i\.workspace_id/,
    "tasks-repo.ts:placementIssueWorkspaceSql": /issue_workspace\.workspace_id = t\.workspace_id/g,
    "tasks-repo.ts:liveIssueWorkspaceMachines": /i\.workspace_id = iw\.workspace_id/,
  };
  for (const file of readdirSync(root).filter((name) => name.endsWith(".ts"))) {
    const ast = ts.createSourceFile(file, readFileSync(`${root}/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = node.getText(ast);
        if (/\bmultiremi_issue_workspaces\b/.test(sql)
          && /\bissue_id\s*=\s*(\?|i\.id|t\.issue_id)/.test(sql)) {
          const key = `${file}:${ownerName(node, ast)}`;
          found.add(key);
          const rule = rules[key];
          if (!rule || !sql.match(rule)) unexpected.push(`${key}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
          if (key === "tasks-repo.ts:placementIssueWorkspaceSql") {
            expect(sql.match(rule!)).toHaveLength(2);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(unexpected).toEqual([]);
  expect([...found].sort()).toEqual(Object.keys(rules).sort());
});

it("Runtime impact lists join current Issue content only inside the record's workspace", () => {
  const source = readFileSync(`${root}/runtimes-repo.ts`, "utf8");
  expect(source).toContain("LEFT JOIN multiremi_issues i ON i.id = iw.issue_id AND i.workspace_id = iw.workspace_id");
  expect(source).toContain("COALESCE(i.title, iw.issue_key)");
});
