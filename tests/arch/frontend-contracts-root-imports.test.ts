import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * The frontend may read `@multiremi/contracts` from its root only as types.
 *
 * The root `index.ts` is a barrel of `export * from "./x.js"`. Type-only imports
 * are erased before bundling, but a value import pulls the barrel into the Next
 * build, and webpack cannot resolve those `.js` specifiers against TS sources:
 * `@multiremi/web build` fails with "Module not found: ./types.js". Unit tests and
 * `tsc` both pass, so nothing short of a production build caught it. This has
 * broken the web image twice (core/runtimes helpers, then MUL-501's activity layer).
 * Runtime values go through a subpath export instead, e.g.
 * `@multiremi/contracts/issue-activity`.
 */
const FRONTEND_ROOTS = [join(REPO_ROOT, "frontend/packages"), join(REPO_ROOT, "frontend/apps")];
const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "out", ".turbo"]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Line numbers of every value import / re-export of the contracts root barrel. */
function contractsRootValueImports(src: string, fileName = "file.ts"): number[] {
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const isRoot = (node: ts.Node | undefined) => node !== undefined
    && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && node.text === "@multiremi/contracts";
  const lines: number[] = [];
  const report = (node: ts.Node) => lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && isRoot(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) report(node);
      else if (!clause.isTypeOnly && (
        !!clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)
        || clause.namedBindings.elements.length === 0
        || clause.namedBindings.elements.some((element) => !element.isTypeOnly)
      )) report(node);
    } else if (ts.isExportDeclaration(node) && isRoot(node.moduleSpecifier) && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause) || clause.elements.length === 0
        || clause.elements.some((element) => !element.isTypeOnly)) report(node);
    } else if (ts.isCallExpression(node)) {
      const runtimeImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (runtimeImport && isRoot(node.arguments[0])) report(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return lines;
}

describe("frontend imports of the @multiremi/contracts root", () => {
  it("are type-only, so the Next build never bundles the .js barrel", () => {
    const offenders: string[] = [];
    for (const root of FRONTEND_ROOTS) {
      for (const file of listTsFiles(root)) {
        const src = readFileSync(file, "utf8");
        if (!src.includes("@multiremi/contracts")) continue;
        for (const line of contractsRootValueImports(src, file)) offenders.push(`${relative(REPO_ROOT, file)}:${line}`);
      }
    }
    expect(offenders, "import runtime values from a subpath export such as @multiremi/contracts/issue-activity").toEqual([]);
  });

  it("detects value imports and accepts type-only forms", () => {
    expect(contractsRootValueImports(`import { issueActivityLayer, type IssueActivityEntry } from "@multiremi/contracts";`)).toEqual([1]);
    expect(contractsRootValueImports(`export { formatRuntimeProtocol } from "@multiremi/contracts";`)).toEqual([1]);
    expect(contractsRootValueImports(`export * from "@multiremi/contracts";`)).toEqual([1]);
    expect(contractsRootValueImports(`import * as c from "@multiremi/contracts";`)).toEqual([1]);
    expect(contractsRootValueImports(`import "@multiremi/contracts";`)).toEqual([1]);
    expect(contractsRootValueImports(`const c = await import("@multiremi/contracts");`)).toEqual([1]);
    expect(contractsRootValueImports([
      `import type { IssueActivityEntry } from "@multiremi/contracts";`,
      `import { type IssueActivityEntry as E } from "@multiremi/contracts";`,
      `export type { IssueActivityEntry } from "@multiremi/contracts";`,
      `export { type IssueActivityEntry } from "@multiremi/contracts";`,
      `import { issueActivityLayer } from "@multiremi/contracts/issue-activity";`,
    ].join("\n"))).toEqual([]);
  });
});

/** Module specifiers a file imports or re-exports as runtime values (type-only forms erased). */
function valueSpecifiers(src: string, fileName = "file.ts"): string[] {
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0
        && clause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    }
  }
  return out;
}

const SOURCE_PACKAGES: Record<string, string> = {
  "@multiremi/contracts": join(REPO_ROOT, "packages/contracts/src"),
  "@multiremi/shared": join(REPO_ROOT, "packages/shared/src"),
};

describe("contracts and shared modules the web bundles", () => {
  it("value-import their siblings without .js, which webpack cannot resolve to the TS source", () => {
    const queue: string[] = [];
    const seen = new Set<string>();
    const visit = (path: string) => { if (existsSync(path) && !seen.has(path)) { seen.add(path); queue.push(path); } };
    for (const root of FRONTEND_ROOTS) {
      for (const file of listTsFiles(root)) {
        for (const specifier of valueSpecifiers(readFileSync(file, "utf8"), file)) {
          for (const [name, dir] of Object.entries(SOURCE_PACKAGES)) {
            if (specifier.startsWith(`${name}/`)) visit(join(dir, `${specifier.slice(name.length + 1).replace(/\.ts$/, "")}.ts`));
          }
        }
      }
    }
    const offenders: string[] = [];
    while (queue.length) {
      const file = queue.shift()!;
      for (const specifier of valueSpecifiers(readFileSync(file, "utf8"), file)) {
        if (!specifier.startsWith(".")) continue;
        if (specifier.endsWith(".js")) offenders.push(`${relative(REPO_ROOT, file)} -> ${specifier}`);
        visit(resolve(dirname(file), `${specifier.replace(/\.js$/, "")}.ts`));
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(offenders, "drop the .js from a value import in a module the web bundles (type imports may keep it)").toEqual([]);
  });

  it("reads value specifiers and skips type-only forms", () => {
    expect(valueSpecifiers(`import { A, type B } from "./a.js";\nexport { C } from "./c.js";\nexport * from "./d.js";`))
      .toEqual(["./a.js", "./c.js", "./d.js"]);
    expect(valueSpecifiers(`import type { A } from "./a.js";\nimport { type B } from "./b.js";\nexport type { C } from "./c.js";`)).toEqual([]);
  });
});
