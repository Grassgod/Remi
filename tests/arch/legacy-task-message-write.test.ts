import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");
const IMPLEMENTATIONS = new Set([
  "packages/server/src/store/store.ts",
  "packages/server/src/store/repos/tasks-repo.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (/^(node_modules|dist|build|\.next|tests?|__tests__|fixtures?)$/.test(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function legacyReferences(source: string): number[] {
  const tree = ts.createSourceFile("producer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "appendTaskMessages") {
      lines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

describe("legacy task-message writer boundary", () => {
  it("forbids production references outside the two Store implementation files", () => {
    const files = ["apps", "packages", "frontend/apps", "frontend/packages"].flatMap((dir) => sources(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(500);
    const violations = files.flatMap((file) => {
      const path = relative(ROOT, file);
      return IMPLEMENTATIONS.has(path) ? [] : legacyReferences(readFileSync(file, "utf8")).map((line) => `${path}:${line}`);
    });
    expect(violations).toEqual([]);
  });

  it("catches calls, computed access and detached aliases without matching comments", () => {
    for (const source of [
      'store.appendTaskMessages("task", []);',
      'store["appendTaskMessages"]("task", []);',
      "const { appendTaskMessages: write } = store; write();",
      "const write = store.appendTaskMessages; write();",
    ]) expect(legacyReferences(source)).toHaveLength(1);
    expect(legacyReferences("// store.appendTaskMessages()")).toEqual([]);
  });
});
