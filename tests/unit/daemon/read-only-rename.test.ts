import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameReadOnlyDirectory } from "@daemon/agent-runtime/workspace/read-only-rename.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      execFileSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
    } catch {
      // The directory may already be gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("renameReadOnlyDirectory", () => {
  // macOS refuses a plain rename of these trees inside one parent, Linux once the parent changes.
  for (const [name, targetOf] of [
    ["inside one parent", (root: string) => join(root, "published")],
    ["to another parent", (root: string) => join(root, "elsewhere", "published")],
  ] as const) {
    it(`moves a read-only tree ${name} and leaves every level read-only`, () => {
      const root = tempDir();
      mkdirSync(join(root, "elsewhere"));
      const source = readOnlyTree(root);
      const target = targetOf(root);

      renameReadOnlyDirectory(source, target);

      expect(existsSync(source)).toBe(false);
      expect(readFileSync(join(target, "docs", "page.md"), "utf8")).toBe("page\n");
      expect(modes(target)).toEqual({ root: 0o555, docs: 0o555, page: 0o444 });
    });
  }

  it("puts the source mode back when the rename fails", () => {
    const root = tempDir();
    const source = readOnlyTree(root);
    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep"), "keep\n");

    expect(() => renameReadOnlyDirectory(source, occupied)).toThrow();

    expect(modes(source)).toEqual({ root: 0o555, docs: 0o555, page: 0o444 });
    expect(readFileSync(join(occupied, "keep"), "utf8")).toBe("keep\n");
  });

  it("moves a link itself without changing the mode of the tree it points to", () => {
    const root = tempDir();
    const tree = readOnlyTree(root);
    const link = join(root, "link");
    symlinkSync(tree, link, "dir");

    renameReadOnlyDirectory(link, join(root, "moved-link"));

    expect(existsSync(link)).toBe(false);
    expect(lstatSync(join(root, "moved-link")).isSymbolicLink()).toBe(true);
    expect(modes(tree)).toEqual({ root: 0o555, docs: 0o555, page: 0o444 });
  });

  it("keeps the mode of a directory that is already writable", () => {
    const root = tempDir();
    const source = join(root, "writable");
    mkdirSync(source, { mode: 0o750 });
    chmodSync(source, 0o750);

    renameReadOnlyDirectory(source, join(root, "moved"));

    expect(lstatSync(join(root, "moved")).mode & 0o777).toBe(0o750);
  });
});

/** A staged tree as intake and snapshot publishing leave it: everything read-only, the root included. */
function readOnlyTree(root: string): string {
  const tree = join(root, ".staging");
  mkdirSync(join(tree, "docs"), { recursive: true });
  writeFileSync(join(tree, "docs", "page.md"), "page\n");
  chmodSync(join(tree, "docs", "page.md"), 0o444);
  chmodSync(join(tree, "docs"), 0o555);
  chmodSync(tree, 0o555);
  return tree;
}

function modes(tree: string): { root: number; docs: number; page: number } {
  return {
    root: lstatSync(tree).mode & 0o777,
    docs: lstatSync(join(tree, "docs")).mode & 0o777,
    page: lstatSync(join(tree, "docs", "page.md")).mode & 0o777,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "read-only-rename-"));
  tempDirs.push(dir);
  return dir;
}
