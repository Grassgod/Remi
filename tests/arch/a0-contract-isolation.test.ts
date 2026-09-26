import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * A-0 ships types, interfaces and in-memory implementations only - no runtime
 * behaviour. The acceptance criterion is that no production code path imports
 * any of it yet, so this file is that criterion's mechanical form: the moment
 * A-1/A-2/A-5/A-6 wire these modules up, these tests fail and the PR that wires
 * them must delete the corresponding entry.
 *
 * A failing test here is not a bug to work around; it means the module left the
 * "types only" phase, which is exactly what the follow-up sub-issues do.
 */

/** Every module A-0 adds, and whether it may be imported by runtime code yet. */
const A0_MODULES = [
  // Imported by nothing outside tests until A-1/A-2/A-5/A-6 wire them up.
  { specifier: "@multiremi/contracts/daemon-protocol", wired: false },
  { specifier: "@multiremi/contracts/trace", wired: false },
  { specifier: "@multiremi/worker/trace-store", wired: false },
  { specifier: "@multiremi/api/trace/trace-sink", wired: false },
  { specifier: "@multiremi/api/trace/daemon-trace-reader", wired: false },
  // A-0b additions: the shared sanitize point and the derived read-side values.
  // Both are called only by tests and by other A-0 modules so far. A-6 wires
  // `trace-sanitize` into the daemon's write path and A-5/A-8 wire
  // `trace-derive` into completion; until then the equivalence tests are what
  // hold them to the current behaviour.
  { specifier: "@shared/trace-sanitize", wired: false },
  { specifier: "@shared/trace-derive", wired: false },
] as const;

/** The one file allowed to import a not-yet-wired module: this guard's own subject list. */
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

/** Where the new modules themselves live - their own definitions are not imports. */
const A0_SOURCES = new Set([
  join(REPO_ROOT, "packages/contracts/src/daemon-protocol.ts"),
  join(REPO_ROOT, "packages/contracts/src/trace.ts"),
  join(REPO_ROOT, "packages/server/src/worker/trace-store.ts"),
  join(REPO_ROOT, "packages/server/src/api/trace/trace-sink.ts"),
  join(REPO_ROOT, "packages/server/src/api/trace/daemon-trace-reader.ts"),
  join(REPO_ROOT, "packages/shared/src/trace-sanitize.ts"),
  join(REPO_ROOT, "packages/shared/src/trace-derive.ts"),
]);

/** Notes on who will consume each module once it is wired. */
const WIRING_OWNER = new Map<string, string>([
  ["@shared/trace-sanitize", "A-6 wires it into the daemon write path; today only tests call it"],
  ["@shared/trace-derive", "A-5/A-8 wire it into completion and the backfill"],
]);

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

describe("A-0 modules are not yet wired into runtime code", () => {
  for (const { specifier, wired } of A0_MODULES) {
    it(`${specifier} is imported by ${wired ? "runtime code" : "nothing but tests"}`, () => {
      const consumers: string[] = [];
      for (const root of RUNTIME_ROOTS) {
        // Fail loudly on a missing root. A guard that silently scans nothing
        // passes forever and tells you nothing; every root below is tracked.
        const files = listTsFiles(root);
        expect(files.length, `${root} yielded no files to scan`).toBeGreaterThan(0);
        for (const file of files) {
          if (A0_SOURCES.has(file)) continue;
          const src = readFileSync(file, "utf8");
          for (const match of src.matchAll(IMPORT_RE)) {
            const spec = match[1]!;
            // Match the bare specifier and its `.js` ESM form.
            if (spec === specifier || spec === `${specifier}.js`) consumers.push(file);
          }
        }
      }
      if (wired) {
        // Name the consumer so a passing case still says who depends on it.
        expect(
          consumers.map((file) => file.replace(`${REPO_ROOT}/`, "")).length,
          `${specifier} should be imported by runtime code by now (${WIRING_OWNER.get(specifier) ?? "unknown consumer"})`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          consumers.map((file) => file.replace(`${REPO_ROOT}/`, "")),
          `${specifier} became reachable from runtime code; this PR must delete its entry from A0_MODULES`,
        ).toEqual([]);
      }
    });
  }

  it("scans a root set broad enough to catch a real wiring", () => {
    // Guard against the failure mode this file itself hit: a scan that finds
    // nothing and therefore passes. Two known-good files must show up.
    const server = listTsFiles(join(REPO_ROOT, "packages/server/src"));
    const contracts = listTsFiles(join(REPO_ROOT, "packages/contracts/src"));
    expect(server.length).toBeGreaterThan(100);
    expect(contracts.length).toBeGreaterThan(8);
    expect(server).toContain(join(REPO_ROOT, "packages/server/src/worker/daemon.ts"));
    expect(contracts).toContain(join(REPO_ROOT, "packages/contracts/src/types.ts"));
  });

  it("would notice a wiring import, proved against the batch this PR adds", () => {
    // The positive control: a file that really does import a new module is
    // detected by the same scan. `tests/unit/daemon/trace-store.test.ts` imports
    // `@multiremi/worker/trace-store`, so the scan must see it.
    const testFile = join(REPO_ROOT, "tests/unit/daemon/trace-store.test.ts");
    const src = readFileSync(testFile, "utf8");
    const specs = [...src.matchAll(IMPORT_RE)].map((match) => match[1]!);
    expect(specs).toContain("@multiremi/worker/trace-store.js");
  });

  it("keeps the contracts barrel from re-exporting the new modules", () => {
    // Importing `@multiremi/contracts` must not drag the protocol or trace
    // modules into every consumer's module graph before they are used.
    const barrel = readFileSync(join(REPO_ROOT, "packages/contracts/src/index.ts"), "utf8");
    for (const { specifier } of A0_MODULES) {
      if (!specifier.startsWith("@multiremi/contracts/")) continue;
      const local = `./${specifier.slice("@multiremi/contracts/".length)}.js`;
      expect(barrel, `the contracts barrel now exports ${local}`).not.toContain(local);
    }
  });
});
