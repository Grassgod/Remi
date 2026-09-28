import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

test("production API role parsing and env reads belong only to config and its startup entry", () => {
  const root = join(import.meta.dir, "../..");
  const violations: string[] = [];
  let resolutions = 0;
  for (const directory of ["apps", "packages"]) {
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: join(root, directory) })) {
      const relative = `${directory}/${file}`;
      const definition = relative === "packages/server/src/config/api-role.ts";
      const entry = relative === "packages/server/src/config/startup-env.ts";
      const source = ts.createSourceFile(relative, readFileSync(join(root, relative), "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && /\b(resolveApiRole|isApiRoleConfigured)$/.test(node.expression.getText(source))) {
          if (!definition && !entry) violations.push(`${relative}: ${node.expression.getText(source)}`);
          if (node.expression.getText(source) === "resolveApiRole") resolutions++;
        }
        if ((ts.isPropertyAccessExpression(node) && node.name.text === "MULTIREMI_API_ROLE")
          || (ts.isElementAccessExpression(node) && node.argumentExpression
            && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "MULTIREMI_API_ROLE")) {
          if (!definition) violations.push(`${relative}: role env read`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  expect(violations).toEqual([]);
  expect(resolutions).toBe(1);
});
