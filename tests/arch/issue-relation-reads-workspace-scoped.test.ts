import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const path = "packages/server/src/store/repos/issues-repo.ts";
const source = readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

it("issue relation SQL scopes content reads to a workspace", () => {
  const unscoped: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const sql = node.getText(ast);
      if (/\bSELECT\b/.test(sql) && /\b(parent_issue_id|depends_on_issue_id)\b/.test(sql)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isMethodDeclaration(owner)) owner = owner.parent;
        const method = owner && ts.isMethodDeclaration(owner) ? owner.name.getText(ast) : "";
        // The duplicate-row probe validates a raw write, without projecting issue content.
        const rawWriteProbe = method === "findIssueDependencyRow";
        // These suffixes inherit both joins from the shared progress query below.
        const sharedProgress = sql.includes("${CHILD_PROGRESS_SELECT}");
        if (!rawWriteProbe && !sharedProgress && !/\bworkspace_id\b/.test(sql)) {
          unscoped.push(`${method || "shared SQL"}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(unscoped).toEqual([]);
});

it("the shared progress query scopes both the parent and prerequisite joins", () => {
  const declaration = ast.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((decl) => decl.name.getText(ast) === "CHILD_PROGRESS_SELECT"));
  const sql = declaration!.getText(ast);
  expect(sql).toContain("parent.workspace_id = child.workspace_id");
  expect(sql).toContain("d.workspace_id = dependent.workspace_id");
  expect(sql).toContain("prereq.workspace_id = dependent.workspace_id");
});
