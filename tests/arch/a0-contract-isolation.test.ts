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
  // A-1 wired the frame vocabulary: `api/daemon-protocol/` reads the frame
  // names, categories, limits, close codes and version checks from it, and
  // `api/server.ts` reads the socket payload ceiling. The rest is untouched.
  { specifier: "@multiremi/contracts/daemon-protocol", wired: true },
  // A-6 now wires the memory implementations, reverse reader and trace frames.
  { specifier: "@multiremi/contracts/trace", wired: true },
  { specifier: "@multiremi/worker/trace-store", wired: true },
  { specifier: "@multiremi/api/trace/trace-sink", wired: true },
  { specifier: "@multiremi/api/trace/daemon-trace-reader", wired: true },
  // A-0b additions: the shared sanitize point and the derived read-side values.
  // A-6 wires sanitize into TraceStore and derive into terminal reports.
  { specifier: "@shared/trace-sanitize", wired: true },
  { specifier: "@shared/trace-derive", wired: true },
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

/**
 * Every root a wiring import could hide in.
 *
 * `packages/*` is enumerated rather than listed: an earlier version named
 * `server`, `daemon` and `contracts` only, and three real runtime packages were
 * therefore invisible — a wiring import in `shared`, `connectors` or
 * `plugin-sdk` left the guard green at 10 pass / 0 fail. All three are genuinely
 * reachable: `worker/daemon.ts` already imports `@connectors/feishu/...`, and
 * `@shared/*` is imported across server and connectors.
 *
 * Enumerating the directory means a package added later is covered without
 * anyone remembering to edit this list.
 */
function runtimeRoots(): string[] {
  const packagesDir = join(REPO_ROOT, "packages");
  const packages = readdirSync(packagesDir)
    .filter((name) => {
      try {
        return statSync(join(packagesDir, name, "src")).isDirectory();
      } catch {
        return false;
      }
    })
    .map((name) => join(packagesDir, name, "src"));

  return [
    ...packages,
    join(REPO_ROOT, "apps"),
    join(REPO_ROOT, "frontend/packages"),
    join(REPO_ROOT, "frontend/apps"),
  ];
}

const RUNTIME_ROOTS = runtimeRoots();

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
  ["@multiremi/contracts/trace", "MUL-435 C0: the Live Hub annotates its events with TraceEvent"],
  ["@multiremi/api/trace/trace-sink", "MUL-435 C0: LiveHub extends A-0's TraceSink"],
  ["@shared/trace-sanitize", "A-6 wires it into the daemon write path; today only tests call it"],
  ["@shared/trace-derive", "A-5/A-8 wire it into completion and the backfill"],
]);

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** The A-0 modules MUL-435's Live Hub takes a type-only reference to. */
const TRACE_CONSUMER_SPECIFIERS = ["@multiremi/contracts/trace", "@multiremi/api/trace/trace-sink"];

/**
 * True when `src` imports `specifier` in its `import type { ... } from "..."` form.
 *
 * Both the bare and the `.js` ESM spelling are accepted, because the codebase uses
 * the extension while the package name is what a reader looks for. A value import
 * does not match: `import type` is the whole point of the assertion.
 */
function hasTypeImport(src: string, specifier: string): boolean {
  const escaped = specifier.replace(/[/.]/g, "\\$&");
  return new RegExp(`import type\\s*\\{[^}]*\\}\\s*from\\s*"${escaped}(\\.js)?";`).test(src);
}

describe("A-0 module wiring boundaries", () => {
  for (const { specifier, wired } of A0_MODULES) {
    it(`${specifier} is imported by ${wired ? "runtime code" : "nothing but tests"}`, () => {
      const consumers: string[] = [];
      for (const root of RUNTIME_ROOTS) {
        // Fail loudly on a missing root. A guard that silently scans nothing
        // passes forever and tells you nothing; every root below is tracked.
        const files = listTsFiles(root);
        expect(files.length, `${root} yielded no files to scan`).toBeGreaterThan(0);
        for (const file of files) {
          // A wired implementation's dependencies are now production consumers.
          if (A0_SOURCES.has(file) && !wired) continue;
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

  it("names the C0 hub as the consumer that flipped trace/trace-sink to wired", () => {
    // The two entries above went from `false` to `true` in MUL-435. Pin *who* the
    // consumer is, so the flip cannot be satisfied by an unrelated runtime import
    // appearing somewhere and leaving this guard green for the wrong reason.
    const hubPath = join(REPO_ROOT, "packages/server/src/api/hub/live-hub.ts");
    const hub = readFileSync(hubPath, "utf8");
    const specs = [...hub.matchAll(IMPORT_RE)].map((match) => match[1]!);
    for (const specifier of TRACE_CONSUMER_SPECIFIERS) {
      // Both the bare and the `.js` ESM spelling count.
      expect(
        specs.includes(specifier) || specs.includes(`${specifier}.js`),
        `live-hub.ts does not import ${specifier}`,
      ).toBe(true);
      // A-0 keeps its "no runtime behaviour" claim only while nothing pulls these
      // modules into a request path at runtime, so the import must be the `import
      // type` form; a value import here would be a real wiring, not a contract
      // reference.
      expect(
        hasTypeImport(hub, specifier),
        `${specifier} must be imported with \`import type\` (with or without \`.js\`)`,
      ).toBe(true);
    }
  });

  it("accepts the bare and the `.js` spelling of a type import alike", () => {
    // The assertion above used to accept a bare specifier for the "is imported"
    // half and then require `\.js` in the shape half, so a bare `import type`
    // would pass one half and fail the other. Pin both spellings, and pin that
    // the shape half still rejects a value import.
    const specifier = "@multiremi/contracts/trace";
    const bare = `import type { TraceEvent } from "${specifier}";`;
    const withExt = `import type { TraceEvent } from "${specifier}.js";`;
    const value = `import { TraceEvent } from "${specifier}.js";`;
    expect(hasTypeImport(bare, specifier)).toBe(true);
    expect(hasTypeImport(withExt, specifier)).toBe(true);
    expect(hasTypeImport(value, specifier)).toBe(false);
  });

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

  it("covers every package that holds runtime code, including the three it used to miss", () => {
    // The blind spot was structural, not incidental: `shared`, `connectors` and
    // `plugin-sdk` are real runtime packages, and a wiring import in any of them
    // was invisible. The expected set is read from the directory rather than
    // restated, so neither a narrowed enumeration nor a package added later can
    // drift from this assertion.
    const expected = readdirSync(join(REPO_ROOT, "packages"))
      .filter((name) => {
        try {
          return statSync(join(REPO_ROOT, "packages", name, "src")).isDirectory();
        } catch {
          return false;
        }
      })
      .map((name) => join(REPO_ROOT, "packages", name, "src"));

    expect(expected.length).toBeGreaterThanOrEqual(10);
    for (const root of expected) {
      expect(RUNTIME_ROOTS, `${root} is not scanned`).toContain(root);
      expect(listTsFiles(root).length, `${root} yielded no files`).toBeGreaterThan(0);
    }
    // The three the earlier version missed, named explicitly so the regression is
    // pinned even if the enumeration above is edited.
    for (const pkg of ["shared", "connectors", "plugin-sdk"]) {
      expect(RUNTIME_ROOTS).toContain(join(REPO_ROOT, "packages", pkg, "src"));
    }
  });

  it("finds the consumers of a shared-package wiring import", () => {
    // Positive control for the widened scan: the three packages that were missing
    // are now genuinely searched, so a real import placed in one of them is seen.
    // This test asserts the scan *reaches* them; the probe in the PR description
    // shows the wiring assertions themselves go red.
    const shared = listTsFiles(join(REPO_ROOT, "packages/shared/src"));
    const connectors = listTsFiles(join(REPO_ROOT, "packages/connectors/src"));
    const pluginSdk = listTsFiles(join(REPO_ROOT, "packages/plugin-sdk/src"));
    expect(shared.length).toBeGreaterThan(10);
    expect(connectors.length).toBeGreaterThan(10);
    expect(pluginSdk.length).toBeGreaterThan(0);
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
