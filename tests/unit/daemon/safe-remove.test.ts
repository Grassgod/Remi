import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNED_DIRECTORY_QUARANTINE,
  ownedDirectoryRemovalSupport,
  recoverOwnedDirectoryQuarantineSync,
  removeOwnedDirectorySync,
} from "@daemon/agent-runtime/workspace/safe-remove.js";

describe("descriptor-safe owned directory removal", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      restoreFixturePermissions(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports descriptor-safe cleanup support to runtime health", () => {
    const support = ownedDirectoryRemovalSupport();
    if (process.platform === "linux") {
      expect(support).toEqual({ capability: "available", supported: true, error: null });
    } else {
      expect(support.capability).toBe("blocked");
      expect(support.supported).toBe(false);
      expect(support.error).toContain(process.platform);
    }
  });

  it("quarantines and removes only the selected owned directory", () => {
    const root = tempRoot(roots);
    const target = join(root, ".task-runtime", "task-1");
    const sibling = join(root, ".task-runtime", "task-2");
    mkdirSync(target, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(target, "result.jsonl"), "{}\n", { mode: 0o400 });
    writeFileSync(join(sibling, "keep.txt"), "keep\n");

    expect(removeOwnedDirectorySync(root, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });

  it("refuses a symlinked parent without touching the outside directory", () => {
    const root = tempRoot(roots);
    const outside = tempRoot(roots);
    const victim = join(outside, "task-1");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "keep\n");
    symlinkSync(outside, join(root, ".task-runtime"), "dir");

    expect(() => removeOwnedDirectorySync(root, join(root, ".task-runtime", "task-1")))
      .toThrow("must be a real directory");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("restores 0555 mode and retains the target when quarantine rename fails", () => {
    const root = tempRoot(roots);
    const target = join(root, "snapshot");
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep\n");
    chmodSync(target, 0o555);
    mkdirSync(quarantine, { mode: 0o500 });
    const originalRename = fs.renameSync;
    let renameError: unknown;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      try {
        originalRename(from, to);
      } catch (error) {
        renameError = error;
        throw error;
      }
    });
    try {
      let thrown: unknown;
      try { removeOwnedDirectorySync(root, target); } catch (error) { thrown = error; }
      expect(rename).toHaveBeenCalledTimes(1);
      expect((renameError as NodeJS.ErrnoException)?.code).toBe("EACCES");
      expect(thrown).toBe(renameError);
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o555);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      rename.mockRestore();
      chmodSync(quarantine, 0o700);
      chmodSync(target, 0o755);
    }
  });

  it("preserves both errors when restoring the target mode also fails", () => {
    const root = tempRoot(roots);
    const target = join(root, "snapshot");
    mkdirSync(target);
    chmodSync(target, 0o555);
    const originalMode = statSync(target).mode;
    const renameError = new Error("quarantine rename failed");
    const restoreError = new Error("mode restore failed");
    const originalFchmod = fs.fchmodSync;
    const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw renameError; });
    const chmod = spyOn(fs, "fchmodSync")
      .mockImplementationOnce(originalFchmod)
      .mockImplementationOnce(() => { throw restoreError; });
    try {
      let thrown: unknown;
      try { removeOwnedDirectorySync(root, target); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([renameError, restoreError]);
      expect(chmod).toHaveBeenCalledTimes(2);
      expect(chmod.mock.calls[1]).toEqual([chmod.mock.calls[0]![0], originalMode]);
      expect(existsSync(target)).toBe(true);
    } finally {
      rename.mockRestore();
      chmod.mockRestore();
      chmodSync(target, 0o755);
    }
  });

  it("treats a missing owned parent as already removed", () => {
    const root = tempRoot(roots);
    expect(removeOwnedDirectorySync(root, join(root, ".task-runtime", "task-1"))).toBe(false);
    expect(existsSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toBe(false);
  });

  it("retains the quarantined generation when the root fence is lost", () => {
    const root = tempRoot(roots);
    const target = join(root, "MUL-1");
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    let fences = 0;

    expect(() => removeOwnedDirectorySync(root, target, {
      assertRootOwner: () => {
        fences++;
        if (fences === 3) throw new Error("workspace ownership lost");
      },
    })).toThrow("workspace ownership lost");

    expect(existsSync(target)).toBe(false);
    const quarantined = readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(root, OWNED_DIRECTORY_QUARANTINE, quarantined[0]!, "session.jsonl"), "utf8"))
      .toBe("durable\n");

    expect(recoverOwnedDirectoryQuarantineSync(root)).toBe(1);
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });

  it.each(["direct", "quarantine recovery"])("removes a 0555 tree via %s without chmod through symlinks", (mode) => {
    const root = tempRoot(roots);
    const target = join(root, "side-session");
    const nested = join(target, "repo", "src");
    const outside = tempRoot(roots);
    const outsideFile = join(outside, "keep.txt");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "code.ts"), "export const value = 1;\n", { mode: 0o444 });
    writeFileSync(outsideFile, "external data\n", { mode: 0o444 });
    symlinkSync(outside, join(nested, "linked-dir"), "dir");
    symlinkSync(outsideFile, join(nested, "linked-file"));
    for (const path of [nested, join(target, "repo"), target, outside]) chmodSync(path, 0o555);

    if (mode === "direct") {
      expect(removeOwnedDirectorySync(root, target)).toBe(true);
    } else {
      let fences = 0;
      expect(() => removeOwnedDirectorySync(root, target, {
        assertRootOwner: () => {
          if (++fences === 3) throw new Error("interrupt before deletion");
        },
      })).toThrow("interrupt before deletion");
      const generation = readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))[0]!;
      const quarantinedPath = join(root, OWNED_DIRECTORY_QUARANTINE, generation);
      // Recovery also handles generations whose root remains read-only,
      // regardless of whether a previous cleanup granted root write access.
      chmodSync(quarantinedPath, 0o555);
      expect(statSync(quarantinedPath).mode & 0o777).toBe(0o555);
      expect(recoverOwnedDirectoryQuarantineSync(root)).toBe(1);
    }

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    expect(statSync(outsideFile).mode & 0o777).toBe(0o444);
    expect(readFileSync(outsideFile, "utf8")).toBe("external data\n");
  });
});

function tempRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-safe-remove-"));
  roots.push(root);
  return root;
}

function restoreFixturePermissions(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  chmodSync(path, info.mode | 0o700);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) restoreFixturePermissions(join(path, name));
  }
}
