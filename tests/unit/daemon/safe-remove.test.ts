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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  OWNED_DIRECTORY_QUARANTINE,
  ownedDirectoryRemovalSupport,
  recoverOwnedDirectoryQuarantineSync,
  removeOwnedDirectorySync,
} from "@daemon/agent-runtime/workspace/safe-remove.js";

// CI only runs Linux, so both addressing strategies are exercised there. A
// darwin host can only run the path-anchored leg: `/proc/self/fd` is missing.
const PLATFORMS = (process.platform === "linux" ? ["linux", "darwin"] : ["darwin"]) as NodeJS.Platform[];

describe.each(PLATFORMS)("anchored owned directory removal (%s)", (platform) => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      restoreFixturePermissions(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports anchored cleanup support to runtime health", () => {
    expect(ownedDirectoryRemovalSupport("darwin")).toEqual({ capability: "available", supported: true, error: null });
    const unsupported = ownedDirectoryRemovalSupport("win32");
    expect(unsupported.capability).toBe("blocked");
    expect(unsupported.supported).toBe(false);
    expect(unsupported.error).toContain("win32");
    // The host platform uses its native strategy; this suite is runnable on a
    // real Mac as well, where the path strategy needs no procfs.
    const native = ownedDirectoryRemovalSupport();
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(native).toEqual({ capability: "available", supported: true, error: null });
    } else {
      expect(native.capability).toBe("blocked");
      expect(native.error).toContain(process.platform);
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

    expect(removeOwnedDirectorySync(root, target, { platform })).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });

  it("refuses a symlinked root or parent without touching the outside directory", () => {
    const outside = tempRoot(roots);
    const victim = join(outside, "task-1");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "keep\n");

    const linkedRoot = join(root(), "linked-workspaces");
    symlinkSync(outside, linkedRoot, "dir");
    expect(() => removeOwnedDirectorySync(linkedRoot, join(linkedRoot, "task-1"), { platform }))
      .toThrow("must be a real directory");

    const root2 = tempRoot(roots);
    symlinkSync(outside, join(root2, ".task-runtime"), "dir");
    expect(() => removeOwnedDirectorySync(root2, join(root2, ".task-runtime", "task-1"), { platform }))
      .toThrow("must be a real directory");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("restores the target and removes nothing when the quarantine rename fails", () => {
    const root = tempRoot(roots);
    const target = join(root, "snapshot");
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep\n");
    chmodSync(target, 0o555);
    mkdirSync(quarantine, { mode: 0o500 });
    const renameError: NodeJS.ErrnoException = Object.assign(
      new Error("EACCES: permission denied, rename"),
      { code: "EACCES" },
    );
    const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw renameError; });
    try {
      let thrown: unknown;
      try { removeOwnedDirectorySync(root, target, { platform }); } catch (error) { thrown = error; }
      expect(rename).toHaveBeenCalledTimes(1);
      expect(thrown).toBe(renameError);
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o555);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
      expect(readdirSync(quarantine)).toEqual([]);
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
      try { removeOwnedDirectorySync(root, target, { platform }); } catch (error) { thrown = error; }
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
    expect(removeOwnedDirectorySync(root, join(root, ".task-runtime", "task-1"), { platform })).toBe(false);
    expect(existsSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toBe(false);
  });

  it("releases every descriptor when the target or an ancestor is already gone", () => {
    const root = tempRoot(roots);
    const present = join(root, ".task-runtime", "task-1");
    mkdirSync(join(root, ".task-runtime"), { recursive: true });
    mkdirSync(present);
    // Count only descriptors that were actually opened: a probe on a missing
    // path throws out of openSync, and nothing leaks by failing to open.
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let opened = 0;
    let closed = 0;
    const open = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof originalOpen>) => {
      const fd = originalOpen(...args);
      opened++;
      return fd;
    });
    const close = spyOn(fs, "closeSync").mockImplementation((...args: Parameters<typeof originalClose>) => {
      closed++;
      return originalClose(...args);
    });
    try {
      for (let attempt = 0; attempt < 25; attempt++) {
        // Deep path whose middle component exists but whose target is gone.
        expect(removeOwnedDirectorySync(root, join(root, ".task-runtime", "missing-target"), { platform }))
          .toBe(false);
        // Deep path whose intermediate ancestor is gone.
        expect(removeOwnedDirectorySync(root, join(root, ".missing-runtime", "missing-target"), { platform }))
          .toBe(false);
      }
      expect(opened).toBe(75);
      expect(closed).toBe(opened);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
    // The fixtures are untouched, so no path leaked into a deletion.
    expect(existsSync(present)).toBe(true);
    expect(existsSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toBe(false);
  });

  it("releases every descriptor when recovery refuses a non-private quarantine", () => {
    const root = tempRoot(roots);
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    mkdirSync(quarantine);
    chmodSync(quarantine, 0o755);
    // Workspace GC reports this refusal and retries every round, so any
    // descriptor left open here accumulates for the daemon's lifetime.
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let opened = 0;
    let closed = 0;
    const open = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof originalOpen>) => {
      const fd = originalOpen(...args);
      opened++;
      return fd;
    });
    const close = spyOn(fs, "closeSync").mockImplementation((...args: Parameters<typeof originalClose>) => {
      closed++;
      return originalClose(...args);
    });
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(() => recoverOwnedDirectoryQuarantineSync(root, { platform }))
          .toThrow("must not be accessible by group or other users");
      }
      expect(opened).toBe(20);
      expect(closed).toBe(opened);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  it("retains a verified quarantine generation when the root fence is lost", () => {
    const root = tempRoot(roots);
    const target = join(root, "MUL-1");
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    let fences = 0;

    expect(() => removeOwnedDirectorySync(root, target, {
      platform,
      assertRootOwner: () => {
        fences++;
        if (fences === 3) throw new Error("workspace ownership lost");
      },
    })).toThrow("workspace ownership lost");

    expect(existsSync(target)).toBe(false);
    const quarantined = readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE));
    expect(quarantined).toHaveLength(1);
    // The third fence runs after the entry was proven identical to the opened
    // directory, so recovery is allowed to finish the deletion.
    expect(quarantined[0]).toMatch(/\.deleting$/);
    expect(readFileSync(join(root, OWNED_DIRECTORY_QUARANTINE, quarantined[0]!, "session.jsonl"), "utf8"))
      .toBe("durable\n");

    expect(recoverOwnedDirectoryQuarantineSync(root, { platform })).toEqual({ recovered: 1, retained: [] });
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
      expect(removeOwnedDirectorySync(root, target, { platform })).toBe(true);
    } else {
      let fences = 0;
      expect(() => removeOwnedDirectorySync(root, target, {
        platform,
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
      expect(recoverOwnedDirectoryQuarantineSync(root, { platform })).toEqual({ recovered: 1, retained: [] });
    }

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    expect(statSync(outsideFile).mode & 0o444).toBe(0o444);
    expect(readFileSync(outsideFile, "utf8")).toBe("external data\n");
  });
});

describe("path-anchored removal on darwin (injected on Linux CI)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      restoreFixturePermissions(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the verified directory when the quarantine rename moved an impostor", () => {
    const root = tempRoot(roots);
    const target = join(root, "MUL-1");
    const aside = join(root, "verified-moved-aside");
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    const originalRename = fs.renameSync;
    let injected = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!injected) {
        injected = true;
        // Swap the verified directory for an impostor immediately before the
        // quarantine rename, so the rename carries the wrong inode.
        originalRename(target, aside);
        mkdirSync(target);
        writeFileSync(join(target, "impostor.txt"), "impostor\n");
      }
      originalRename(from, to);
    });
    try {
      expect(() => removeOwnedDirectorySync(root, target, { platform: "darwin" }))
        .toThrow("identity changed");
    } finally {
      rename.mockRestore();
    }

    // Nothing was deleted: the verified directory is intact, the impostor went
    // back to the original pathname, and the quarantine holds no queue.
    expect(readFileSync(join(aside, "session.jsonl"), "utf8")).toBe("durable\n");
    expect(readFileSync(join(target, "impostor.txt"), "utf8")).toBe("impostor\n");
    expect(readdirSync(join(root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
    expect(recoverOwnedDirectoryQuarantineSync(root, { platform: "darwin" }))
      .toEqual({ recovered: 0, retained: [] });
  });

  it("retains an unverified quarantine entry when the source path is occupied", () => {
    const root = tempRoot(roots);
    const target = join(root, "MUL-4");
    const aside = join(root, "verified-moved-aside");
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    const originalRename = fs.renameSync;
    let injected = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!injected) {
        injected = true;
        originalRename(target, aside);
        mkdirSync(target);
        writeFileSync(join(target, "impostor.txt"), "impostor\n");
        originalRename(from, to);
        // Occupy the original pathname so the mismatch cannot be rolled back.
        mkdirSync(target);
        writeFileSync(join(target, "occupant.txt"), "occupant\n");
        return;
      }
      originalRename(from, to);
    });
    try {
      expect(() => removeOwnedDirectorySync(root, target, { platform: "darwin" }))
        .toThrow("retained as");
    } finally {
      rename.mockRestore();
    }

    expect(readFileSync(join(aside, "session.jsonl"), "utf8")).toBe("durable\n");
    expect(readFileSync(join(target, "occupant.txt"), "utf8")).toBe("occupant\n");
    const pending = readdirSync(quarantine);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatch(/\.pending$/);

    // Recovery reports the unproven entry instead of deleting or stalling on it.
    const errors: string[] = [];
    expect(recoverOwnedDirectoryQuarantineSync(root, {
      platform: "darwin",
      onError: (path, error) => errors.push(`${basename(path)}:${errorMessage(error)}`),
    })).toEqual({ recovered: 0, retained: ["MUL-4"] });
    expect(errors).toEqual([`${pending[0]}:quarantined deletion was not verified before the crash: ${pending[0]}`]);
    expect(readdirSync(quarantine)).toEqual(pending);
    expect(readFileSync(join(quarantine, pending[0]!, "impostor.txt"), "utf8")).toBe("impostor\n");
  });

  it("restores the target when the quarantine parent is replaced by a symlink", () => {
    const root = tempRoot(roots);
    const outside = tempRoot(roots);
    const target = join(root, "MUL-5");
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    const movedQuarantine = join(root, "quarantine-moved-aside");
    mkdirSync(target);
    writeFileSync(join(target, "session.jsonl"), "durable\n");
    const originalRename = fs.renameSync;
    let injected = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!injected) {
        injected = true;
        // Redirect the quarantine to an attacker-controlled directory: the
        // moved inode lands outside the owned root but must come back.
        originalRename(quarantine, movedQuarantine);
        symlinkSync(outside, quarantine, "dir");
      }
      originalRename(from, to);
    });
    try {
      expect(() => removeOwnedDirectorySync(root, target, { platform: "darwin" }))
        .toThrow("quarantine was replaced");
    } finally {
      rename.mockRestore();
    }

    expect(readFileSync(join(target, "session.jsonl"), "utf8")).toBe("durable\n");
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(quarantine).isSymbolicLink()).toBe(true);
  });

  it("reclaims verified generations while reporting every other quarantine entry", () => {
    const root = tempRoot(roots);
    const quarantine = join(root, OWNED_DIRECTORY_QUARANTINE);
    const generation = `MUL-7.${process.pid}.${randomUUID()}.deleting`;
    mkdirSync(join(quarantine, generation), { recursive: true, mode: 0o700 });
    chmodSync(quarantine, 0o700);
    writeFileSync(join(quarantine, generation, "history.jsonl"), "archived\n");
    mkdirSync(join(quarantine, "operator-notes"));
    writeFileSync(join(quarantine, "stray.txt"), "stray\n");
    const errors: string[] = [];

    const recovery = recoverOwnedDirectoryQuarantineSync(root, {
      platform: "darwin",
      onError: (path) => errors.push(basename(path)),
    });

    expect(recovery.recovered).toBe(1);
    expect([...recovery.retained].sort()).toEqual(["operator-notes", "stray.txt"]);
    expect([...errors].sort()).toEqual(["operator-notes", "stray.txt"]);
    expect(readdirSync(quarantine).sort()).toEqual(["operator-notes", "stray.txt"]);
  });
});

function root(): string {
  return mkdtempSync(join(tmpdir(), "multiremi-safe-remove-"));
}

function tempRoot(roots: string[]): string {
  const created = root();
  roots.push(created);
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreFixturePermissions(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  chmodSync(path, info.mode | 0o700);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) restoreFixturePermissions(join(path, name));
  }
}
