import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "../..");

/**
 * Rule A: the only files that may hold the bun:sqlite `Database` value, and the only uses each may make of it.
 * Everywhere else `Database` is a type (`import type` / `import { type Database }`), so no alias, re-export,
 * or reflection trick can reach the constructor. No file needs another bun:sqlite value today; add a reasoned
 * exception here before importing one.
 */
const valueAllowed: Record<string, { uses: string[]; reason: string }> = {
  "packages/server/src/store/db/sqlite.ts": {
    uses: ["new", "deserialize"],
    reason: "The SQLite factory owns creation and marks every returned handle.",
  },
  "packages/shared/src/db/index.ts": {
    uses: ["new"],
    reason: "Shared must not depend on server; openMultiremiDatabase marks getDb() before store use.",
  },
  "packages/shared/src/db/sqlite-custom.ts": {
    uses: ["setCustomSQLite"],
    reason: "Swaps the macOS SQLite library before any handle exists; it never creates a handle.",
  },
};

/** Rule B: the only files that may create a handle. */
const constructionAllowed = ["packages/server/src/store/db/sqlite.ts", "packages/shared/src/db/index.ts"];

type Rule = "A" | "B" | "C";

const hints: Record<Rule, string> = {
  A: "only the entry files may hold the bun:sqlite Database value; elsewhere use `import type` and create handles "
    + "with openSqliteDatabase() or deserializeSqliteDatabase() from @multiremi/store/db/sqlite.js. "
    + "Passing a possible bun:sqlite specifier to any function is treated as loading it; use other text for labels.",
  B: "use openSqliteDatabase() or deserializeSqliteDatabase() from @multiremi/store/db/sqlite.js; "
    + "use markSqliteDialect() for existing handles and SQLite wrappers.",
  C: "never re-export bun:sqlite values (export type is fine); import the factory from @multiremi/store/db/sqlite.js instead.",
};

interface Construction {
  line: number;
  column: number;
  expression: string;
}

interface Finding {
  rule: Rule;
  line: number;
  column: number;
  detail: string;
}

interface Scan {
  findings: Finding[];
  /** Named `Database` value imports; an entry file with none no longer needs its whitelist entry. */
  databaseImports: number;
  uses: Set<string>;
  constructions: Construction[];
}

const unwrap = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
};

function sqliteConstructions(text: string, filename = "probe.ts"): Construction[] {
  return constructionsIn(ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true));
}

function constructionsIn(source: ts.SourceFile): Construction[] {
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

/** Apply rules A, B, and C to one file; `file` is the repository path used for the whitelists. */
function scanSqliteUse(text: string, filename: string, file = filename): Scan {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const policy = valueAllowed[file];
  const findings: Finding[] = [];
  const report = (rule: Rule, node: ts.Node, detail: string): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ rule, line: position.line + 1, column: position.character + 1, detail });
  };
  const snippet = (node: ts.Node): string => node.getText(source).replace(/\s+/g, " ").slice(0, 80);

  // Over-approximate names from same-file declarations, parameter/destructuring defaults, and assignments.
  // Evaluate literals, templates, identifiers, +, conditionals, logical/sequence/assignment results,
  // and parentheses, type wrappers, or await. Substring pruning is sound only for concatenation.
  // Runtime object/function boundaries are unknown: property/element access (objects, arrays, classes,
  // namespaces, enums), object keys, for-in/of, spread, call/method returns (String, toString,
  // valueOf, join, concat), argument-to-parameter flow, return/yield, throw-to-catch, tagged templates
  // such as String.raw, cross-file constants, eval, and Function. E3 catches a complete specifier passed
  // as an argument, not fragments such as load("sqlite") later combined with "bun:".
  // Transforms such as slice() and replace() would require a new analysis.
  const declarations: ts.VariableDeclaration[] = [];
  const bindings = new Map<string, { expression: ts.Expression; append: boolean }[]>();
  const addBinding = (name: string, expression: ts.Expression, append = false): void => {
    const entries = bindings.get(name) ?? [];
    entries.push({ expression, append });
    bindings.set(name, entries);
  };
  const gather = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (ts.isIdentifier(node.name) && node.initializer) addBinding(node.name.text, node.initializer);
    } else if ((ts.isParameter(node) || ts.isBindingElement(node))
      && ts.isIdentifier(node.name) && node.initializer) {
      addBinding(node.name.text, node.initializer);
    } else if (ts.isBinaryExpression(node)) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.BarBarEqualsToken
          || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
          || operator === ts.SyntaxKind.QuestionQuestionEqualsToken || operator === ts.SyntaxKind.PlusEqualsToken) {
          addBinding(left.text, node.right, operator === ts.SyntaxKind.PlusEqualsToken);
        }
      }
    } else if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer) {
      addBinding(node.name.text, node.objectAssignmentInitializer);
    }
    ts.forEachChild(node, gather);
  };
  gather(source);

  type Values = Set<string>;
  const empty = (): Values => new Set<string>();
  const values = new Map<string, Values>();
  const insert = (target: Values, value: string): void => {
    if ("bun:sqlite".includes(value)) target.add(value);
  };
  const combine = (left: Values, right: Values): Values => {
    const result = empty();
    for (const a of left) for (const b of right) insert(result, a + b);
    return result;
  };
  const constantStrings = (expression: ts.Expression): Values => {
    expression = unwrap(expression);
    if (ts.isStringLiteralLike(expression)) {
      const result = empty();
      insert(result, expression.text);
      return result;
    }
    if (ts.isIdentifier(expression)) return values.get(expression.text) ?? empty();
    if (ts.isConditionalExpression(expression)) {
      return new Set([...constantStrings(expression.whenTrue), ...constantStrings(expression.whenFalse)]);
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.PlusEqualsToken) {
        return combine(constantStrings(expression.left), constantStrings(expression.right));
      }
      if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
        return constantStrings(expression.right);
      }
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarEqualsToken
        || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return new Set([...constantStrings(expression.left), ...constantStrings(expression.right)]);
      }
    }
    if (ts.isTemplateExpression(expression)) {
      const head = empty();
      insert(head, expression.head.text);
      let result = head;
      for (const span of expression.templateSpans) {
        const literal = empty();
        insert(literal, span.literal.text);
        result = combine(combine(result, constantStrings(span.expression)), literal);
      }
      return result;
    }
    return empty();
  };
  let changed = true;
  let rounds = 0;
  while (changed) {
    if (++rounds > bindings.size * 56 + 1) throw new Error("SQLite specifier analysis did not converge");
    changed = false;
    for (const [name, entries] of bindings) {
      const current = values.get(name) ?? empty();
      const next: Values = new Set(current);
      for (const { expression, append } of entries) {
        const candidate = append ? combine(current, constantStrings(expression)) : constantStrings(expression);
        for (const value of candidate) insert(next, value);
      }
      if (next.size !== current.size) {
        values.set(name, next);
        changed = true;
      }
    }
  }
  const isSpecifier = (expression: ts.Expression | undefined): boolean =>
    expression !== undefined && [...constantStrings(expression)].some(value => value === "bun:sqlite");

  // A: every way of obtaining a bun:sqlite value. Entry files must use a named `Database` import so each use is checked.
  const databaseNames = new Set<string>();
  const valueNames = new Set<string>();
  let databaseImports = 0;
  const acquire = (node: ts.Node, name: string | undefined, database: boolean): void => {
    if (name) valueNames.add(name);
    if (database && name) {
      databaseNames.add(name);
      databaseImports++;
    }
    if (!policy) report("A", node, `${snippet(node)} obtains a bun:sqlite value outside the entry files`);
    else if (!database) report("A", node, `${snippet(node)}: entry files may only import { Database } by name`);
  };
  const acquisitions = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isSpecifier(node.moduleSpecifier)
      && node.importClause && !node.importClause.isTypeOnly) {
      const { name, namedBindings } = node.importClause;
      if (name) acquire(name, name.text, false);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) acquire(namedBindings, namedBindings.name.text, false);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (!element.isTypeOnly) acquire(element, element.name.text, (element.propertyName ?? element.name).text === "Database");
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && isSpecifier(node.moduleReference.expression)) {
      acquire(node, node.name.text, false);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.some(isSpecifier)) {
      // Any call handed a possible specifier counts as a loader; labels must use other text.
      acquire(node, undefined, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isSpecifier(node.moduleSpecifier) && !node.isTypeOnly
      && (!node.exportClause || ts.isNamespaceExport(node.exportClause)
        || node.exportClause.elements.some(element => !element.isTypeOnly))) {
      report("C", node, `${snippet(node)} re-exports bun:sqlite`);
    }
    ts.forEachChild(node, acquisitions);
  };
  acquisitions(source);

  // Local names that hold a bun:sqlite value, followed through declarations for rule C.
  const holdsValue = (expression: ts.Expression): boolean => {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) return valueNames.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return holdsValue(expression.expression);
    }
    return ts.isCallExpression(expression) && expression.arguments.some(isSpecifier);
  };
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) valueNames.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  for (let size = -1; size !== valueNames.size;) {
    size = valueNames.size;
    for (const declaration of declarations) {
      if (declaration.initializer && holdsValue(declaration.initializer)) bind(declaration.name);
    }
  }

  // C: local re-exports, in every file including the entry files.
  const reexports = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && !node.isTypeOnly
      && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        if (!element.isTypeOnly && valueNames.has((element.propertyName ?? element.name).text)) {
          report("C", element, `export { ${snippet(element)} } re-exports a bun:sqlite value`);
        }
      }
    } else if (ts.isExportAssignment(node) && holdsValue(node.expression)) {
      report("C", node, `${snippet(node)} re-exports a bun:sqlite value`);
    } else if (ts.isVariableStatement(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer && holdsValue(declaration.initializer)) {
          report("C", declaration, `export ${snippet(declaration)} re-exports a bun:sqlite value`);
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && /^(module\.)?exports\b/.test(node.left.getText(source)) && holdsValue(node.right)) {
      report("C", node, `${snippet(node)} re-exports a bun:sqlite value`);
    }
    ts.forEachChild(node, reexports);
  };
  reexports(source);

  // A, entry files: every value reference of Database must be one of the file's listed uses.
  const uses = new Set<string>();
  if (policy) {
    const nameSlot = (identifier: ts.Identifier): boolean => {
      const parent = identifier.parent;
      return (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isClassElement(parent)
        || ts.isEnumMember(parent)) && parent.name === identifier;
    };
    const useOf = (identifier: ts.Identifier): string => {
      const parent = identifier.parent;
      if (ts.isNewExpression(parent) && parent.expression === identifier) return "new";
      if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return parent.name.text;
      return "escape";
    };
    const references = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      // Types never reach the constructor, but `class X extends Database` does.
      if (ts.isTypeNode(node) && !(ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)
        && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent))) return;
      if (ts.isIdentifier(node) && databaseNames.has(node.text) && !nameSlot(node)) {
        const use = useOf(node);
        uses.add(use);
        if (!policy.uses.includes(use)) {
          report("A", node, `${snippet(node.parent)}: this file may only use Database for ${policy.uses.join(", ")}`);
        }
      }
      ts.forEachChild(node, references);
    };
    references(source);
  }

  // B: handle creation outside the factory files. A already rejects variable-based module loading elsewhere.
  const constructions = constructionsIn(source);
  if (!constructionAllowed.includes(file)) {
    for (const construction of constructions) {
      findings.push({ rule: "B", line: construction.line, column: construction.column,
        detail: `${construction.expression}(...) creates a SQLite handle` });
    }
  }
  findings.sort((left, right) => left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule));
  return { findings, databaseImports, uses, constructions };
}

const summary = (scan: Scan): string[] => scan.findings.map(finding => `${finding.rule}:${finding.line}`).sort();
const extensions = ["ts", "tsx", "js", "mjs"];

describe("SQLite handle entry", () => {
  test("tracked source keeps the Database value and handle creation inside the entry files", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")
      .filter(file => /\.(ts|tsx|js|mjs)$/.test(file) && !file.endsWith(".d.ts")
        && !/(^|\/)(node_modules|dist|build|out|coverage|\.next|\.git|\.cache)\//.test(file));
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    const stale: string[] = [];
    const scanned = new Map<string, Scan>();
    for (const file of files) {
      const scan = scanSqliteUse(readFileSync(join(root, file), "utf8"), file);
      if (valueAllowed[file] || constructionAllowed.includes(file)) scanned.set(file, scan);
      for (const finding of scan.findings) {
        violations.push(`${file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.detail}; ${hints[finding.rule]}`);
      }
    }
    // The whitelists must stay exact: a missing file or an entry that is no longer needed fails.
    for (const [file, policy] of Object.entries(valueAllowed)) {
      const scan = scanned.get(file);
      if (!scan) stale.push(`${file}: whitelisted for rule A but not tracked`);
      else if (!scan.databaseImports) stale.push(`${file}: no longer imports the Database value; drop it from rule A`);
      else for (const use of policy.uses) if (!scan.uses.has(use)) stale.push(`${file}: no longer uses Database for ${use}`);
    }
    for (const file of constructionAllowed) {
      if (!scanned.get(file)?.constructions.length) stale.push(`${file}: no longer creates a handle; drop it from rule B`);
    }
    expect(stale).toEqual([]);
    expect(violations, violations.join("\n")).toEqual([]);
  }, 120_000);

  // D. Self-checks: each case runs as ts, tsx, js, and mjs; results are `rule:line`.
  const outside: [string, string[], string[]][] = [
    ["cross-module bridge (QA case 1)", ['export { Database } from "bun:sqlite";'], ["C:1"]],
    ["renamed bridge", ['export { Database as Db } from "bun:sqlite";'], ["C:1"]],
    ["bridge consumer that takes the value itself", ['import { Database } from "bun:sqlite";', 'new Database(":memory:");'],
      ["A:1", "B:2"]],
    ["method alias (QA case 2)", ['import { Database } from "bun:sqlite";', "const open = Database.open;", 'open(":memory:");'],
      ["A:1"]],
    ["late-assigned alias (QA case 3)",
      ['import { Database } from "bun:sqlite";', "let D: typeof Database;", "D = Database;", 'new D(":memory:");'], ["A:1"]],
    ["destructured method", ['import { Database } from "bun:sqlite";', "const { open } = Database;", 'open(":memory:");'],
      ["A:1"]],
    ["element access", ['import { Database } from "bun:sqlite";', 'Database["open"](":memory:");'], ["A:1", "B:2"]],
    ["Reflect.construct", ['import { Database } from "bun:sqlite";', "Reflect.construct(Database, []);"], ["A:1"]],
    ["export *", ['export * from "bun:sqlite";'], ["C:1"]],
    ["export * as", ['export * as sqlite from "bun:sqlite";'], ["C:1"]],
    ["export default", ['import { Database } from "bun:sqlite";', "export default Database;"], ["A:1", "C:2"]],
    ["local export", ['import { Database } from "bun:sqlite";', "export { Database };"], ["A:1", "C:2"]],
    ["exported alias", ['import { Database } from "bun:sqlite";', "export const Db = Database;"], ["A:1", "C:2"]],
    ["exported namespace", ['import * as sqlite from "bun:sqlite";', "export { sqlite };"], ["A:1", "C:2"]],
    ["CommonJS export", ['const sqlite = require("bun:sqlite");', "module.exports = sqlite;"], ["A:1", "C:2"]],
    ["default import", ['import Sqlite from "bun:sqlite";'], ["A:1"]],
    ["namespace import", ['import * as sqlite from "bun:sqlite";'], ["A:1"]],
    ["import-equals", ['import sqlite = require("bun:sqlite");'], ["A:1"]],
    ["other value import", ['import { constants } from "bun:sqlite";'], ["A:1"]],
    ["multi-line import", ["import {", "  type SQLQueryBindings,", "  Database,", '} from "bun:sqlite";'], ["A:3"]],
    ["dynamic import", ['const { Database } = await import("bun:sqlite");'], ["A:1"]],
    ["template specifier", ['const sqlite = await import(`bun:sqlite`);'], ["A:1"]],
    ["computed specifier", ['const name = "bun:" + "sqlite";', "const sqlite = await import(name);"], ["A:2"]],
    ["conditional specifier (QA round 3)",
      ['const moduleName = true ? "bun:sqlite" : "node:fs";',
        'const { Database } = await import(moduleName);', 'new Database(":memory:");'], ["A:2"]],
    ["logical-or result",
      ['let fallback = "";', 'const m = fallback || "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["nullish result",
      ['let fallback;', 'const m = fallback ?? "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["logical-and result",
      ['const ready = true;', 'const m = ready && "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["assignment result",
      ['let m;', 'import(m = "bun:sqlite");'], ["A:2"]],
    ["append assignment result",
      ['let m = "bun:";', 'import(m += "sqlite");'], ["A:2"]],
    ["sequence result",
      ['let tick = 0;', 'import((tick++, "bun:sqlite"));'], ["A:2"]],
    ["conditional within concatenation",
      ['import("bun:" + (flag ? "sqlite" : "unrelated"));'], ["A:1"]],
    ["conditional within template",
      ['import(`bun:${flag ? "sqlite" : "x"}`);'], ["A:1"]],
    ["nullish assignment result",
      ['let m;', 'import(m ??= "bun:sqlite");'], ["A:2"]],
    ["logical-or assignment result",
      ['let m;', 'import(m ||= "bun:sqlite");'], ["A:2"]],
    ["logical-and assignment result",
      ['let m = "bun:sqlite";', 'import(m &&= "bun:sqlite");'], ["A:2"]],
    ["conditional label result is conservatively rejected",
      ['label(flag ? "bun:sqlite" : "x");'], ["A:1"]],
    ["function scope shadow (QA round 2)",
      ['const moduleName = "bun:sqlite";', 'function unrelated() {', '  const moduleName = "node:fs";',
        '  return moduleName;', '}', 'const sqlite = await import(moduleName);'], ["A:6"]],
    ["block scope shadow",
      ['const m = "bun:sqlite";', '{ const m = "node:fs"; }', 'await import(m);'], ["A:3"]],
    ["reverse scope shadow",
      ['const m = "node:fs";', '{ const m = "bun:sqlite";', '  await import(m);', '}'], ["A:3"]],
    ["late assignment",
      ['let m = "node:fs";', 'm = "bun:sqlite";', 'await import(m);'], ["A:3"]],
    ["parenthesized assignment",
      ['let m;', '(m) = "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["append assignment",
      ['let m = "bun";', 'm += ":";', 'm += "sqlite";', 'require(m);'], ["A:4"]],
    ["parenthesized append assignment",
      ['let m = "bun";', '(m) += ":";', '(m) += "sqlite";', 'import(m);'], ["A:4"]],
    ["parameter default",
      ['function load(m = "bun:sqlite") { return import(m); }'], ["A:1"]],
    ["binding default",
      ['const { m = "bun:sqlite" } = {};', 'import(m);'], ["A:2"]],
    ["shorthand destructuring assignment default",
      ['let m;', '({ m = "bun:sqlite" } = {});', 'import(m);'], ["A:3"]],
    ["nullish assignment",
      ['let m;', 'm ??= "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["logical-or assignment",
      ['let m;', 'm ||= "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["logical-and assignment",
      ['let m = "node:fs";', 'm &&= "bun:sqlite";', 'import(m);'], ["A:3"]],
    ["self-appended candidate",
      ['let m = "bun:";', 'm += m;', 'm += "sqlite";', 'import(m);'], ["A:4"]],
    ["literal passed to a label function is conservatively rejected",
      ['function label(s) { return s; }', 'label("bun:sqlite");'], ["A:2"]],
    ["createRequire",
      ['import { createRequire } from "node:module";', "const load = createRequire(import.meta.url);", 'load("bun:sqlite");'],
      ["A:3"]],
  ];
  for (const [title, lines, expected] of outside) {
    test(`scanner flags ${title}`, () => {
      for (const extension of extensions) expect(summary(scanSqliteUse(lines.join("\n"), `probe.${extension}`))).toEqual(expected);
    });
  }

  const typedAssignments: [string, string, string[]][] = [
    ["as assertion", '(m as string) = "bun:sqlite";', ["ts", "tsx"]],
    ["non-null assertion", 'm! = "bun:sqlite";', ["ts", "tsx"]],
    ["satisfies assertion", '(m satisfies string) = "bun:sqlite";', ["ts", "tsx"]],
    ["angle-bracket assertion", '(<string>m) = "bun:sqlite";', ["ts"]],
  ];
  for (const [title, assignment, typeExtensions] of typedAssignments) {
    test(`scanner flags ${title} on an assignment target`, () => {
      for (const extension of typeExtensions) {
        const source = `let m: string | undefined;\n${assignment}\nimport(m);`;
        expect(summary(scanSqliteUse(source, `probe.${extension}`))).toEqual(["A:3"]);
      }
    });
  }

  const custom = "packages/shared/src/db/sqlite-custom.ts";
  const factory = "packages/server/src/store/db/sqlite.ts";
  const inside: [string, string, string[], string[]][] = [
    ["the library swap", custom, ['import { Database } from "bun:sqlite";', "Database.setCustomSQLite(path);"], []],
    ["a method alias", custom, ['import { Database } from "bun:sqlite";', "const open = Database.open;"], ["A:2"]],
    ["a construction", custom, ['import { Database } from "bun:sqlite";', 'new Database(":memory:");'], ["A:2", "B:2"]],
    ["a namespace import", custom, ['import * as sqlite from "bun:sqlite";'], ["A:1"]],
    ["a re-export", custom, ['export { Database } from "bun:sqlite";'], ["C:1"]],
    ["a local export", factory, ['import { Database } from "bun:sqlite";', "export { Database };"], ["A:2", "C:2"]],
    ["export default", factory, ['import { Database } from "bun:sqlite";', "export default Database;"], ["A:2", "C:2"]],
    ["a returned value", factory, ['import { Database } from "bun:sqlite";', "export const leak = () => Database;"], ["A:2"]],
    ["a subclass", factory, ['import { Database } from "bun:sqlite";', "class Db extends Database {}"], ["A:2"]],
    ["the factory's own uses", factory,
      ['import { Database } from "bun:sqlite";', "let options: ConstructorParameters<typeof Database>[1];",
        "new Database(filename, options);", "Database.deserialize(bytes);"], []],
  ];
  for (const [title, file, lines, expected] of inside) {
    test(`scanner checks ${title} in ${file}`, () => {
      for (const extension of extensions) {
        expect(summary(scanSqliteUse(lines.join("\n"), `probe.${extension}`, file))).toEqual(expected);
      }
    });
  }

  test("scanner accepts types, the factory, and unrelated code", () => {
    const allowed = [
      'import type { Database } from "bun:sqlite";\nlet db: Database;',
      'import { type Database, type SQLQueryBindings } from "bun:sqlite";\nlet db: Database;',
      'export type { Database } from "bun:sqlite";',
      'export type * from "bun:sqlite";',
      'import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";\nconst db = openSqliteDatabase();',
      'import { Database } from "another-db";\nnew Database();',
      'const label = "bun:sqlite";\n// new Database(":memory:");\nconst example = `new Database(":memory:")`;',
      'const m = "node:fs";\n{ const m = "node:path"; }\nimport(m);',
      'let m = "a"; m += m; m += m; import(m);',
      'import(flag ? "node:fs" : "node:path");',
      'const m = x || "node:fs"; import(m);',
      'check(name === "bun:sqlite");',
      `db.exec(${JSON.stringify(`CREATE TABLE example (${"column TEXT, ".repeat(30)}id TEXT)`)})`,
    ];
    for (const text of allowed) {
      for (const extension of extensions) expect(summary(scanSqliteUse(text, `probe.${extension}`))).toEqual([]);
    }
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
    test(`construction check rejects ${setup} ${code}`, () => {
      for (const extension of extensions) {
        const found = sqliteConstructions(`${setup}\n${code}`, `probe.${extension}`);
        expect(found).toHaveLength(1);
        expect(found[0].line).toBe(2);
        expect(found[0].column).toBe(1);
      }
    });
  }

  test("construction check ignores comments, string literals, types, and unrelated databases", () => {
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
