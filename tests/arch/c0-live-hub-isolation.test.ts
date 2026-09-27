import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * C0 ships types, an interface and an empty implementation — no behaviour. The
 * acceptance criterion is that the skeleton "can be referenced by the server
 * without changing any existing behaviour", so this file is that criterion's
 * mechanical form, and a failing test here is not a bug: it means C1/C2/C3 wired
 * the hub up, which is exactly what those sub-issues do. That PR must delete the
 * corresponding entry below (same contract MUL-401's A-0 guard uses).
 */

/** Every module C0 adds, and whether runtime code may import it yet. */
const C0_MODULES = [
  { specifier: "@multiremi/contracts/live-hub", wired: false },
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

describe("C0 live-hub modules are not yet wired into runtime code", () => {
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
