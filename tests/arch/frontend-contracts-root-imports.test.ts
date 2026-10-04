import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
