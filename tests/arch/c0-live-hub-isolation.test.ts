import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 * C1 (MUL-436) and C3 (MUL-438) wire these three modules. What "wired" means
 * is deliberately narrow: imported by runtime code **outside** the hub package,
 * which is the fact that decides whether the hub can be reached at all.
 *
 * - `contracts/live-hub` — wired: `api/server.ts` reads the role types and
 *   `api/hub/hub-core.ts` the frame contract, and the subpath export is the only
 *   way in.
 * - `api/hub/live-hub` — wired: `api/server.ts` imports the `LiveHub` interface.
 * - `api/hub/hub-transport` — wired: `api/server.ts` constructs the local adapter
 *   (and `hub-role-guard.ts` is the process-level consumer). Step 3 adds the peer
 *   adapter behind the same interface; that is a new implementation, not a new
 *   reason for this entry to exist.
 * - `api/hub/upstream-contracts` — still false: B0's hand-written stand-in, which
 *   disappears when MUL-425 lands.
 *
 * C7's narrower constraint remains independent: replica modules may reference
 * the contract only as types, even though C3's runtime now imports its values.
 * The AST guard below rejects value imports and re-exports in the replica.
 */
const C0_MODULES = [
  { specifier: "@multiremi/contracts/live-hub", wired: true },
  { specifier: "@multiremi/api/hub/live-hub", wired: true },
  { specifier: "@multiremi/api/hub/hub-transport", wired: true },
  // Still unreachable in the sense this guard measures: the only importer is
  // `hub/live-hub.ts`, and it reaches the file relatively (`./upstream-contracts.js`)
  // because they are two files of one seam. The stand-in leaves when B0 (PR #262)
  // lands, which replaces it with `@multiremi/contracts/conversation-log.js`.
  { specifier: "@multiremi/api/hub/upstream-contracts", wired: false },
] as const;

// The checkout is immutable throughout these guards. Reuse only filesystem
// discovery and source bytes; each contract keeps its own matching/assertions.
const directorySnapshot = new Map<string, string[]>();
const sourceSnapshot = new Map<string, string>();
function sourceText(file: string): string {
  if (!sourceSnapshot.has(file)) sourceSnapshot.set(file, readFileSync(file, "utf8"));
  return sourceSnapshot.get(file)!;
}

function listTsFiles(dir: string): readonly string[] {
  const cached = directorySnapshot.get(dir);
  if (cached) return cached;
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  directorySnapshot.set(dir, out);
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
  // C1/C3's own modules, so their imports of the C0 surface are not counted as
  // "runtime wired" on the strength of the hub importing itself.
  join(REPO_ROOT, "packages/server/src/api/hub/browser-stream.ts"),
  join(REPO_ROOT, "packages/server/src/api/hub/stream-auth.ts"),
]);

/**
 * The hub package itself.
 *
 * C1 fills `api/hub/` in, so its modules import each other by construction; those
 * intra-package imports say nothing about whether the rest of the server can reach
 * the hub. A `wired: true` entry is therefore satisfied only by a consumer
 * *outside* this directory — `server.ts` for the hub, `apps/` or the CLI for the
 * guard — which is the fact that actually matters.
 */
const HUB_PACKAGE = join(REPO_ROOT, "packages/server/src/api/hub");

/**
 * Whether an import specifier reaches `specifier` from `fromFile`.
 *
 * Two spellings reach the same module here, and the scan has to see both or it
 * proves nothing: the package subpath (`@multiremi/api/hub/live-hub`, resolved
 * through `packages/server/package.json`'s `"./*": "./src/*"` export) and a
 * relative path (`./hub/live-hub.js`), which is how `api/server.ts` imports its
 * siblings. The relative branch normalises to the repo path before comparing, so a
 * file cannot dodge the guard by choosing one spelling over the other.
 */
function matchesSpecifier(spec: string, specifier: string, fromFile: string): boolean {
  if (spec === specifier || spec === `${specifier}.js`) return true;
  if (!spec.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  const target = specifier === "@multiremi/contracts/live-hub"
    ? join(REPO_ROOT, "packages/contracts/src/live-hub")
    : join(REPO_ROOT, "packages/server/src", specifier.replace("@multiremi/api/", "api/"));
  return resolved === target;
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function hasLiveHubValueImport(src: string): boolean {
  const file = ts.createSourceFile("replica.ts", src, ts.ScriptTarget.Latest, true);
  const isLiveHub = (node: ts.Node | undefined) => node !== undefined
    && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && /^@multiremi\/contracts\/live-hub(?:\.js)?$/.test(node.text);
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isImportDeclaration(node) && isLiveHub(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) found = true;
      else if (!clause.isTypeOnly) {
        found = !!clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)
          || clause.namedBindings.elements.length === 0
          || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
      }
    } else if (ts.isExportDeclaration(node) && isLiveHub(node.moduleSpecifier) && !node.isTypeOnly) {
      const clause = node.exportClause;
      found = !clause || ts.isNamespaceExport(clause) || clause.elements.length === 0
        || clause.elements.some(element => !element.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found = !node.isTypeOnly && isLiveHub(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const runtimeImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      found = runtimeImport && isLiveHub(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
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
    ['import {} from "@multiremi/contracts/live-hub";', true],
    ['const hub = await import("@multiremi/contracts/live-hub");', true],
    ['const hub = require("@multiremi/contracts/live-hub");', true],
    ['import hub = require("@multiremi/contracts/live-hub");', true],
    ['type Frame = import("@multiremi/contracts/live-hub").HubFrame;', false],
    ['export { parseHubStreamKey as qaR1Parse } from "@multiremi/contracts/live-hub";', true],
    ['export { type HubFrame, parseHubStreamKey } from "@multiremi/contracts/live-hub";', true],
    ['export * from "@multiremi/contracts/live-hub";', true],
    ['export * as hub from "@multiremi/contracts/live-hub.js";', true],
    ['export {} from "@multiremi/contracts/live-hub";', true],
    ['export type { HubFrame } from "@multiremi/contracts/live-hub";', false],
    ['export { type HubFrame } from "@multiremi/contracts/live-hub";', false],
    ['export type * from "@multiremi/contracts/live-hub";', false],
    ['export type * as hub from "@multiremi/contracts/live-hub";', false],
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
          const source = sourceText(file);
          for (const match of source.matchAll(IMPORT_RE)) {
            const spec = match[1]!;
            if (!matchesSpecifier(spec, specifier, file)) continue;
            // For the hub's own modules, an import from inside the package is not
            // wiring — it is what C1 filling the package in looks like. For the
            // contracts module it *is*: `hub-core.ts` is the runtime consumer that
            // makes the subpath reachable.
            const intraPackage = specifier.startsWith("@multiremi/api/hub/");
            if (intraPackage && file.startsWith(`${HUB_PACKAGE}/`)) continue;
            consumers.push(file);
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
      const src = sourceText(file);
      if (hasLiveHubValueImport(src)) valueImports.push(file.replace(`${REPO_ROOT}/`, ""));
      for (const match of src.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (spec !== "@multiremi/contracts/live-hub" && spec !== "@multiremi/contracts/live-hub.js") continue;
        consumers.push(file.replace(`${REPO_ROOT}/`, ""));
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
