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
