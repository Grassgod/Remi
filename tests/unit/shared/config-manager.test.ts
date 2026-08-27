import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacySoulSymlink } from "@shared/infra/config-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPaths() {
  const root = mkdtempSync(join(tmpdir(), "remi-config-manager-"));
  roots.push(root);
  const claudeHome = join(root, ".claude");
  const remiHome = join(root, ".remi");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(remiHome, { recursive: true });
  return {
    source: join(claudeHome, "CLAUDE.md"),
    legacySoul: join(remiHome, "soul.md"),
    otherTarget: join(root, "project-instructions.md"),
  };
}

test("removes only the legacy soul instructions symlink", () => {
  const { source, legacySoul } = createPaths();
  writeFileSync(legacySoul, "legacy persona");
  symlinkSync(legacySoul, source);

  expect(removeLegacySoulSymlink(source, legacySoul)).toBe(true);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(legacySoul, "utf8")).toBe("legacy persona");
});

test("preserves a real instructions file", () => {
  const { source, legacySoul } = createPaths();
  writeFileSync(source, "user instructions");

  expect(removeLegacySoulSymlink(source, legacySoul)).toBe(false);
  expect(lstatSync(source).isFile()).toBe(true);
});

test("preserves an instructions symlink to another target", () => {
  const { source, legacySoul, otherTarget } = createPaths();
  writeFileSync(otherTarget, "project instructions");
  symlinkSync(otherTarget, source);

  expect(removeLegacySoulSymlink(source, legacySoul)).toBe(false);
  expect(readlinkSync(source)).toBe(otherTarget);
});
