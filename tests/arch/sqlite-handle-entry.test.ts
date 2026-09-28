import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "../..");
const allowedFiles: Record<string, string> = {
  "packages/server/src/store/db/sqlite.ts": "The SQLite factory owns creation and marks every returned handle.",
  "packages/shared/src/db/index.ts": "Shared must not depend on server; openMultiremiDatabase marks getDb() before store use.",
};

interface Construction {
  line: number;
  column: number;
  expression: string;
}

function sqliteConstructions(text: string, filename = "probe.ts"): Construction[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const modules = new Set<string>();
  const constructors = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "bun:sqlite" && node.importClause && !node.importClause.isTypeOnly) {
      if (node.importClause.name) constructors.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly && ["Database", "default"].includes((binding.propertyName ?? binding.name).text)) {
            constructors.add(binding.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return expression;
  };
  const member = (expression: ts.Expression): { object: ts.Expression; name: string } | undefined => {
    expression = unwrap(expression);
    if (ts.isPropertyAccessExpression(expression)) return { object: expression.expression, name: expression.name.text };
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
      return { object: expression.expression, name: expression.argumentExpression.text };
    }
  };
  const isSqliteModule = (expression: ts.Expression): boolean => {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) return modules.has(expression.text);
    return ts.isCallExpression(expression)
      && (expression.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(expression.expression) && expression.expression.text === "require"))
      && expression.arguments.length === 1 && ts.isStringLiteral(expression.arguments[0])
      && expression.arguments[0].text === "bun:sqlite";
  };
  const isDatabase = (expression: ts.Expression): boolean => {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) return constructors.has(expression.text);
    const property = member(expression);
    return property !== undefined && ["Database", "default"].includes(property.name) && isSqliteModule(property.object);
  };

  // Follow local aliases and destructured dynamic imports, regardless of declaration order.
  let previousSize = -1;
  while (previousSize !== modules.size + constructors.size) {
    previousSize = modules.size + constructors.size;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        if (isSqliteModule(declaration.initializer)) modules.add(declaration.name.text);
        if (isDatabase(declaration.initializer)) constructors.add(declaration.name.text);
      } else if (ts.isObjectBindingPattern(declaration.name) && isSqliteModule(declaration.initializer)) {
        for (const binding of declaration.name.elements) {
          if (!binding.dotDotDotToken && ts.isIdentifier(binding.name)
            && ["Database", "default"].includes((binding.propertyName ?? binding.name).getText(source).replace(/["']/g, ""))) {
            constructors.add(binding.name.text);
          }
        }
      }
    }
  }

  const found: Construction[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const property = member(node.expression);
      if (isDatabase(node.expression)
        || (ts.isCallExpression(node) && property && ["open", "deserialize"].includes(property.name)
          && isDatabase(property.object))) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ line: position.line + 1, column: position.character + 1, expression: node.expression.getText(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("SQLite handle entry", () => {
  test("all tracked source creates SQLite handles through the marked factory", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")
      .filter(file => /\.(ts|tsx|js|mjs)$/.test(file) && !file.endsWith(".d.ts")
        && !/(^|\/)(node_modules|dist|build|out|coverage|\.next|\.git|\.cache)\//.test(file));
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    const allowedSeen = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      if (!text.includes("bun:sqlite")) continue;
      const found = sqliteConstructions(text, file);
      if (allowedFiles[file]) {
        if (found.length) allowedSeen.add(file);
        continue;
      }
      for (const entry of found) violations.push(`${file}:${entry.line}:${entry.column} (${entry.expression})`);
    }
    expect(allowedSeen).toEqual(new Set(Object.keys(allowedFiles)));
    expect(violations, "Use openSqliteDatabase() or deserializeSqliteDatabase() from @multiremi/store/db/sqlite.js; "
      + "use markSqliteDialect() for existing handles and SQLite wrappers.\n" + violations.join("\n")).toEqual([]);
  });

  const forbidden = [
    ['import { Database } from "bun:sqlite";', 'new Database(":memory:");'],
    ['import { Database as X } from "bun:sqlite";', 'new X(":memory:");'],
    ['import X from "bun:sqlite";', 'new X(":memory:");'],
    ['import { default as X } from "bun:sqlite";', 'X.open(":memory:");'],
    ['import { Database as X } from "bun:sqlite";', 'X.open(":memory:");'],
    ['import { Database } from "bun:sqlite";', 'Database.deserialize(bytes);'],
    ['import { Database } from "bun:sqlite";', 'Database.open(":memory:");'],
    ['import * as sqlite from "bun:sqlite";', 'new sqlite.Database(":memory:");'],
    ['', 'new (await import("bun:sqlite")).Database(":memory:");'],
    ['', '(await import("bun:sqlite")).Database(":memory:");'],
    ['', '(await import("bun:sqlite")).Database.open(":memory:");'],
    ['', 'new (await import("bun:sqlite")).default(":memory:");'],
    ['const { Database: X } = await import("bun:sqlite");', 'new X(":memory:");'],
    ['const sqlite = await import("bun:sqlite");', 'sqlite.Database.deserialize(bytes);'],
    ['const sqlite = require("bun:sqlite");', 'new sqlite["Database"](":memory:");'],
    ['const { Database } = require("bun:sqlite");', 'Database.open(":memory:");'],
    ['import { Database } from "bun:sqlite"; const X = Database;', 'new X(":memory:");'],
  ];
  for (const [setup, code] of forbidden) {
    test(`scanner rejects ${setup} ${code}`, () => {
      for (const filename of ["probe.ts", "probe.tsx", "probe.js", "probe.mjs"]) {
        const found = sqliteConstructions(`${setup}\n${code}`, filename);
        expect(found).toHaveLength(1);
        expect(found[0].line).toBe(2);
        expect(found[0].column).toBe(1);
      }
    });
  }

  test("scanner ignores comments, string literals, types, and unrelated databases", () => {
    expect(sqliteConstructions(`
      import { Database } from "bun:sqlite";
      // new Database(":memory:");
      const example = 'Database.open(":memory:")';
      const template = \`new Database(":memory:")\`;
      const typed: Database = openSqliteDatabase();
    `)).toEqual([]);
    expect(sqliteConstructions('import type { Database } from "bun:sqlite"; new Database();')).toEqual([]);
    expect(sqliteConstructions('import { type Database } from "bun:sqlite"; new Database();')).toEqual([]);
    expect(sqliteConstructions('import { Database } from "another-db"; new Database();')).toEqual([]);
    expect(sqliteConstructions('import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js"; openSqliteDatabase();')).toEqual([]);
  });
});
