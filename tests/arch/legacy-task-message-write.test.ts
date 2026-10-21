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

const LEGACY_NAME = "appendTaskMessages";

// Unicode/hex escapes and line continuations, which can spell the name in an identifier or string.
const ESCAPES = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\\r?\n/g;

/**
 * Whether a file can hold a reference at all: its text contains the name once
 * escapes are decoded. Only those files are parsed and walked; walking the
 * syntax tree of all ~1,700 production files took 3-10 s against the 5 s budget.
 */
function mayReference(source: string): boolean {
  if (source.includes(LEGACY_NAME)) return true;
  if (!/\\[ux\r\n]/.test(source)) return false;
  return source.replace(ESCAPES, (match, braced?: string, unicode?: string, hex?: string) => {
    const digits = braced ?? unicode ?? hex;
    if (digits === undefined) return "";
    const code = parseInt(digits, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }).includes(LEGACY_NAME);
}

function legacyReferences(source: string): number[] {
  if (!mayReference(source)) return [];
  const tree = ts.createSourceFile("producer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === LEGACY_NAME) {
      lines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

describe("legacy task-message writer boundary", () => {
  // Reads every production source (~1,700 files, ~17 MB) and parses the few that name the
  // writer: well under a second on CI, so 15 s only absorbs a slow disk.
  it("forbids production references outside the two Store implementation files", () => {
    const files = ["apps", "packages", "frontend/apps", "frontend/packages"].flatMap((dir) => sources(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(500);
    const violations = files.flatMap((file) => {
      const path = relative(ROOT, file);
      return IMPLEMENTATIONS.has(path) ? [] : legacyReferences(readFileSync(file, "utf8")).map((line) => `${path}:${line}`);
    });
    expect(violations).toEqual([]);
  }, 15_000);

  it("catches calls, computed access and detached aliases without matching comments", () => {
    for (const source of [
      'store.appendTaskMessages("task", []);',
      'store["appendTaskMessages"]("task", []);',
      "const { appendTaskMessages: write } = store; write();",
      "const write = store.appendTaskMessages; write();",
      'store.append\\u0054askMessages("task", []);',
      'store["append\\x54askMessages"]("task", []);',
      'store["\\u{61}ppendTaskMessages"]("task", []);',
      'store["append\\\nTaskMessages"]("task", []);',
    ]) expect(legacyReferences(source)).toHaveLength(1);
    expect(legacyReferences("// store.appendTaskMessages()")).toEqual([]);
    expect(mayReference("store.appendTaskMessage(task);")).toBe(false);
    expect(mayReference('const s = "\\u0041\\x42\\u{1F600}\\u{FFFFFFF}";')).toBe(false);
  });
});
