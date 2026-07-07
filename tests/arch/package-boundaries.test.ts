import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CONTRACTS_SRC = join(import.meta.dir, "../../packages/contracts/src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Match import/export ... from "<spec>" and dynamic import("<spec>")
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

describe("packages/contracts boundaries", () => {
  const files = listTsFiles(CONTRACTS_SRC);

  test("contracts stays pure: no runtime/env dependencies and no escaping relative imports", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");

      expect(src, `${file} must not import from "bun`).not.toContain('from "bun');
      expect(src, `${file} must not import from "bun:`).not.toContain('from "bun:');
      expect(src, `${file} must not import from "node:`).not.toContain('from "node:');
      expect(src, `${file} must not reference process.`).not.toContain("process.");

      for (const match of src.matchAll(SPECIFIER_RE)) {
        const spec = match[1];
        if (spec.startsWith(".")) {
          expect(spec, `${file} relative import must not escape packages/contracts/src: ${spec}`).not.toContain("../");
        }
      }
    }
  });

  test("contracts has no back-dependency on application src/", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(SPECIFIER_RE)) {
        const spec = match[1];
        expect(spec, `${file} must not import from src/: ${spec}`).not.toContain("src/");
      }
    }
  });
});

// ── No package may depend back on the application core (src/remi, src/multiremi) ──
const PACKAGES_ROOT = join(import.meta.dir, "../../packages");
const BOUNDED_PACKAGES = [
  "queue",
  "daemon",
  "shared",
  "acp",
  "memory",
  "auth",
  "connectors",
  "contracts",
];

/** True if a module specifier reaches into src/remi or src/multiremi. */
function isCoreBackEdge(spec: string): boolean {
  // Allowed real-package aliases that merely share the @remi/@multiremi prefix.
  if (spec === "@remi/plugin-sdk" || spec.startsWith("@remi/plugin-sdk/")) return false;
  if (spec === "@multiremi/contracts" || spec.startsWith("@multiremi/contracts/")) return false;

  // Alias forms that resolve to src/remi/* or src/multiremi/*.
  if (spec === "@remi" || spec.startsWith("@remi/")) return true;
  if (spec === "@multiremi" || spec.startsWith("@multiremi/")) return true;

  // Relative forms that escape into the application core.
  if (spec.includes("src/remi/") || spec.includes("src/multiremi/")) return true;

  return false;
}

describe("packages/* have no back-edge into application core", () => {
  for (const pkg of BOUNDED_PACKAGES) {
    test(`packages/${pkg}/src does not import from src/remi or src/multiremi`, () => {
      const files = listTsFiles(join(PACKAGES_ROOT, pkg, "src"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        for (const match of src.matchAll(SPECIFIER_RE)) {
          const spec = match[1];
          expect(
            isCoreBackEdge(spec),
            `packages/${pkg} must not import application core: ${spec} (in ${file})`,
          ).toBe(false);
        }
      }
    });
  }
});
