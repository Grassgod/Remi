import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * C0 ships types, an interface and an empty implementation — no behaviour. The
 * acceptance criterion is that the skeleton "can be referenced by the server
 * without changing any existing behaviour", so this file is that criterion's
 * mechanical form, and a failing test here is not a bug: it means C1/C2/C3 wired
 * the hub up, which is exactly what those sub-issues do. That PR must delete the
 * corresponding entry below (same contract MUL-401's A-0 guard uses).
 */

/**
 * Every module C0 adds, and whether runtime code may import it yet.
 *
 * `@multiremi/contracts/live-hub` was removed from this list by MUL-442 (C7): the
 * browser replica speaks the v2 frames C0 defines, so it imports the contract's
 * types — the same relationship MUL-435 (C0) took to A-0's `TraceEvent`, and the
 * plan's own instruction (C3 未合入时按 C0 契约先写). The three server modules stay
 * unwired: the hub's implementation is C1/C2/C3's to fill in. The removed entry's
 * real guarantee is kept below by
 * 「the contract is referenced by type only」, which is the property that broke
 * `next build` (MUL-108, MUL-314) rather than the presence of the reference.
 */
const C0_MODULES = [
  { specifier: "@multiremi/api/hub/live-hub", wired: false },
  { specifier: "@multiremi/api/hub/hub-transport", wired: false },
  { specifier: "@multiremi/api/hub/upstream-contracts", wired: false },
] as const;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const RUNTIME_ROOTS = [
  join(REPO_ROOT, "packages/server/src"),
  join(REPO_ROOT, "packages/daemon/src"),
  join(REPO_ROOT, "packages/contracts/src"),
  join(REPO_ROOT, "apps"),
  join(REPO_ROOT, "frontend/packages"),
  join(REPO_ROOT, "frontend/apps"),
];

/** The C0 sources themselves: their own definitions are not imports. */
const C0_SOURCES = new Set([
  join(REPO_ROOT, "packages/contracts/src/live-hub.ts"),
  join(REPO_ROOT, "packages/server/src/api/hub/live-hub.ts"),
  join(REPO_ROOT, "packages/server/src/api/hub/hub-transport.ts"),
  join(REPO_ROOT, "packages/server/src/api/hub/upstream-contracts.ts"),
]);

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function hasLiveHubValueImport(src: string): boolean {
  const file = ts.createSourceFile("replica.ts", src, ts.ScriptTarget.Latest, true);
  return file.statements.some((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return false;
    if (!/^@multiremi\/contracts\/live-hub(?:\.js)?$/.test(node.moduleSpecifier.text)) return false;
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  });
}

describe("C0 live-hub modules are not yet wired into runtime code", () => {
  it.each([
    ['import type { HubFrame } from "@multiremi/contracts/live-hub";', false],
    ['import { type HubFrame } from "@multiremi/contracts/live-hub";', false],
    ['import { parseHubStreamKey } from "@multiremi/contracts/live-hub";', true],
    ['import type { HubFrame } from "@multiremi/contracts/live-hub"; import { parseHubStreamKey } from "@multiremi/contracts/live-hub"; export const parse = parseHubStreamKey;', true],
    ['import { type HubFrame, parseHubStreamKey } from "@multiremi/contracts/live-hub";', true],
    ['import * as hub from "@multiremi/contracts/live-hub.js";', true],
    ['import "@multiremi/contracts/live-hub";', true],
  ])("classifies each individual contract import: %s", (source, expected) => {
    expect(hasLiveHubValueImport(source)).toBe(expected);
  });
  for (const { specifier, wired } of C0_MODULES) {
    it(`${specifier} is imported by ${wired ? "runtime code" : "nothing but tests"}`, () => {
      const consumers: string[] = [];
      for (const root of RUNTIME_ROOTS) {
        const files = listTsFiles(root);
        // A guard that silently scans nothing passes forever; every root is tracked.
        expect(files.length, `${root} yielded no files to scan`).toBeGreaterThan(0);
        for (const file of files) {
          if (C0_SOURCES.has(file)) continue;
          const src = readFileSync(file, "utf8");
          for (const match of src.matchAll(IMPORT_RE)) {
            const spec = match[1]!;
            if (spec === specifier || spec === `${specifier}.js`) consumers.push(file);
          }
        }
      }
      if (wired) {
        expect(consumers.length, `${specifier} should be imported by runtime code by now`).toBeGreaterThan(0);
      } else {
        expect(
          consumers.map((file) => file.replace(`${REPO_ROOT}/`, "")),
          `${specifier} became reachable from runtime code; this PR must delete its entry from C0_MODULES`,
        ).toEqual([]);
      }
    });
  }

  it("the replica references the v2 frames as types, never as runtime values", () => {
    // Why this replaces the removed C0_MODULES entry rather than dropping the
    // check: a *value* import from this module is what broke `next build` twice,
    // and it is the shape a later edit would reach for by accident (importing
    // `parseHubStreamKey` into a client module). `import type` is erased, so the
    // reference costs nothing at runtime; a value import fails here.
    const replicaDir = join(REPO_ROOT, "frontend/packages/core/replica");
    const files = listTsFiles(replicaDir).filter((file) => !file.endsWith(".test.ts"));
    expect(files.length, "no replica modules to scan").toBeGreaterThan(5);
    const valueImports: string[] = [];
    const consumers: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (spec !== "@multiremi/contracts/live-hub" && spec !== "@multiremi/contracts/live-hub.js") continue;
        consumers.push(file.replace(`${REPO_ROOT}/`, ""));
        if (hasLiveHubValueImport(src)) {
          valueImports.push(file.replace(`${REPO_ROOT}/`, ""));
        }
      }
    }
    // Positive control: the scan has to see the imports it is judging, or a typo
    // in the specifier would make this test a permanent green no-op.
    expect(consumers.length, "the replica no longer imports the v2 frame contract").toBeGreaterThan(0);
    expect(valueImports, "these files must use `import type` for the v2 frames").toEqual([]);
  });

  it("scans a root set broad enough to catch a real wiring", () => {
    const server = listTsFiles(join(REPO_ROOT, "packages/server/src"));
    const contracts = listTsFiles(join(REPO_ROOT, "packages/contracts/src"));
    expect(server.length).toBeGreaterThan(100);
    expect(contracts.length).toBeGreaterThan(8);
    expect(server).toContain(join(REPO_ROOT, "packages/server/src/worker/daemon.ts"));
    expect(contracts).toContain(join(REPO_ROOT, "packages/contracts/src/types.ts"));
  });

  it("would notice a wiring import, proved against this sub-issue's own test", () => {
    // Positive control: the contract test really imports the hub modules, so the
    // same scan must see them there. Without this, a typo in the specifier list
    // would turn every entry above into a permanent false negative.
    const testFile = join(REPO_ROOT, "tests/unit/multiremi/live-hub-contract.test.ts");
    const specs = [...readFileSync(testFile, "utf8").matchAll(IMPORT_RE)].map((match) => match[1]!);
    expect(specs).toContain("@multiremi/api/hub/live-hub");
    expect(specs).toContain("@multiremi/contracts/live-hub");
  });

  it("keeps the contracts barrel from re-exporting the live-hub module", () => {
    // The module ships runtime values; a barrel value-import is what broke
    // `next build` twice (MUL-108, MUL-314). Subpath only.
    const barrel = readFileSync(join(REPO_ROOT, "packages/contracts/src/index.ts"), "utf8");
    expect(barrel).not.toContain("./live-hub.js");
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages/contracts/package.json"), "utf8"));
    expect(manifest.exports["./live-hub"]).toBe("./src/live-hub.ts");
  });
});
