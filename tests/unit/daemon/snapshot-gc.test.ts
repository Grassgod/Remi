import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MultiremiRepoCache, withRepoCacheLock } from "@daemon/agent-runtime/repo/checkout.js";
import { runSnapshotGcOnce, type RunSnapshotGcOnceOptions } from "@daemon/agent-runtime/repo/snapshot-gc.js";
import { OWNED_DIRECTORY_QUARANTINE } from "@daemon/agent-runtime/workspace/safe-remove.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

const roots: string[] = [];
const ttlMs = 60_000;

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("snapshot TTL GC", () => {
  it("removes expired trees but retains fresh trees and the exact TTL boundary", async () => {
    const f = fixture();
    const old = f.tree("old", f.now - ttlMs - 1);
    const boundary = f.tree("boundary", f.now - ttlMs);
    const fresh = f.tree("fresh", f.now);
    expect(await runSnapshotGcOnce(f.options)).toEqual({ removed: 1, retained: 2, skipped: 0 });
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(boundary, "nested", "file"), "utf8")).toBe("snapshot");
    expect(existsSync(fresh)).toBe(true);
  });

  it("reclaims expired orphan snapshots when the repo cache workspace directory is missing", async () => {
    const f = fixture();
    const orphan = f.tree("orphan", f.now - ttlMs - 1);
    rmSync(dirname(f.barePath), { recursive: true });
    expect(existsSync(dirname(f.barePath))).toBe(false);

    expect(await runSnapshotGcOnce(f.options)).toEqual({ removed: 1, retained: 0, skipped: 0 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(dirname(f.barePath))).toBe(true);
    expect(existsSync(`${f.barePath}.multiremi.lock`)).toBe(false);
  });

  it("reclaims 0555 directories and 0444 files, including abandoned temporary trees", async () => {
    const f = fixture();
    for (const name of ["commit", ".commit.tmp-123-456"]) {
      const path = f.tree(name, f.now - ttlMs - 1);
      chmodSync(join(path, "nested", "file"), 0o444);
      chmodSync(join(path, "nested"), 0o555);
      chmodSync(path, 0o555);
    }
    const calls: string[] = [];
    expect(await runSnapshotGcOnce({
      ...f.options,
      withRepoLock: async (path, fn) => {
        calls.push(path);
        await f.options.withRepoLock(path, fn);
      },
    })).toEqual({ removed: 2, retained: 0, skipped: 0 });
    expect(calls).toEqual([f.barePath]);
    expect(existsSync(f.repoDir)).toBe(false);
    expect(readdirSync(join(f.root, OWNED_DIRECTORY_QUARANTINE))).toEqual([]);
  });

  it("removes empty repo directories under the lock and ages empty workspace directories separately", async () => {
    const f = fixture();
    mkdirSync(f.repoDir, { recursive: true });
    let held = false;
    await runSnapshotGcOnce({
      ...f.options,
      withRepoLock: async (path, fn) => {
        await f.options.withRepoLock(path, () => {
          held = true;
          fn();
          expect(existsSync(f.repoDir)).toBe(false);
          held = false;
        });
      },
      assertRootOwner: () => {
        if (existsSync(join(f.root, OWNED_DIRECTORY_QUARANTINE))) expect(held).toBe(true);
      },
    });
    expect(existsSync(f.wsDir)).toBe(true);
    age(f.wsDir, f.now - ttlMs - 1);
    await runSnapshotGcOnce(f.options);
    expect(existsSync(f.wsDir)).toBe(false);
    expect(existsSync(f.snapshotsRoot)).toBe(true);
  });

  it("skips a repository held by another cache instance without touching its trees", async () => {
    const f = fixture();
    const path = f.tree("old", f.now - ttlMs - 1);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const owner = new MultiremiRepoCache(f.repoCacheRoot);
    const holding = owner.runExclusiveForBarePath(f.barePath, async () => {
      entered();
      await held;
    });
    await started;
    const errors: unknown[] = [];
    try {
      expect(await runSnapshotGcOnce({ ...f.options, onError: (_path, error) => errors.push(error) }))
        .toEqual({ removed: 0, retained: 0, skipped: 1 });
      expect(String(errors[0])).toContain("timed out waiting for repo cache lock");
      expect(readFileSync(join(path, "nested", "file"), "utf8")).toBe("snapshot");
    } finally {
      release();
      await holding;
    }
  });

  it("rechecks mtime after acquiring the lock", async () => {
    const f = fixture();
    const path = f.tree("old", f.now - ttlMs - 1);
    expect(await runSnapshotGcOnce({
      ...f.options,
      withRepoLock: async (barePath, fn) => {
        age(path, f.now);
        await f.options.withRepoLock(barePath, fn);
      },
    })).toEqual({ removed: 0, retained: 1, skipped: 0 });
    expect(existsSync(path)).toBe(true);
  });

  it("isolates an entry removal failure and continues with the next tree", async () => {
    const f = fixture();
    const blocked = f.tree("a-blocked", f.now - ttlMs - 1);
    const next = f.tree("b-next", f.now - ttlMs - 1);
    let failNext = false;
    const errors: string[] = [];
    expect(await runSnapshotGcOnce({
      ...f.options,
      withRepoLock: async (path, fn) => f.options.withRepoLock(path, () => {
        failNext = true;
        fn();
      }),
      assertRootOwner: () => {
        if (failNext) {
          failNext = false;
          throw new Error("ownership fence rejected deletion");
        }
      },
      onError: (path) => errors.push(path),
    })).toEqual({ removed: 1, retained: 0, skipped: 1 });
    expect(errors).toEqual([blocked]);
    expect(existsSync(blocked)).toBe(true);
    expect(existsSync(next)).toBe(false);
  });

  it.each(["workspace", "repo", "snapshot"] as const)("never follows a %s symlink", async (level) => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "nested", "sentinel"), "keep");
    age(outside, f.now - ttlMs - 1);
    const link = level === "workspace" ? f.wsDir : level === "repo" ? f.repoDir : join(f.repoDir, "link");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    const originalMode = statSync(outside).mode;
    expect((await runSnapshotGcOnce(f.options)).removed).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "nested", "sentinel"), "utf8")).toBe("keep");
    expect(statSync(outside).mode).toBe(originalMode);
  });

  it("rejects symlink replacement of an ancestor while waiting for the lock", async () => {
    const f = fixture();
    f.tree("old", f.now - ttlMs - 1);
    const moved = join(f.root, "moved");
    const result = await runSnapshotGcOnce({
      ...f.options,
      withRepoLock: async (path, fn) => {
        renameSync(f.wsDir, moved);
        symlinkSync(moved, f.wsDir);
        await f.options.withRepoLock(path, fn);
      },
    });
    expect(result).toEqual({ removed: 0, retained: 0, skipped: 1 });
    expect(readFileSync(join(moved, basename(f.repoDir), "old", "nested", "file"), "utf8")).toBe("snapshot");
  });

  it("removes a snapshot containing escaping links without changing their targets", async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "keep", { mode: 0o444 });
    chmodSync(outside, 0o555);
    const directoryMode = statSync(outside).mode;
    const fileMode = statSync(sentinel).mode;
    const path = f.tree("old", f.now);
    symlinkSync(outside, join(path, "directory-link"));
    symlinkSync(sentinel, join(path, "file-link"));
    age(path, f.now - ttlMs - 1);

    expect(await runSnapshotGcOnce(f.options)).toEqual({ removed: 1, retained: 0, skipped: 0 });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(statSync(outside).mode).toBe(directoryMode);
    expect(statSync(sentinel).mode).toBe(fileMode);
  });

  it("skips files and quarantine names at every level", async () => {
    const f = fixture();
    f.tree("old", f.now - ttlMs - 1);
    for (const parent of [f.snapshotsRoot, f.wsDir, f.repoDir]) {
      mkdirSync(join(parent, OWNED_DIRECTORY_QUARANTINE));
      writeFileSync(join(parent, "file"), "keep");
    }
    expect(await runSnapshotGcOnce(f.options)).toEqual({ removed: 1, retained: 0, skipped: 6 });
    expect(existsSync(f.repoDir)).toBe(true);
  });

  it("returns zero for missing, file, or symlink roots and rejects roots outside its owner", async () => {
    const f = fixture();
    const zero = { removed: 0, retained: 0, skipped: 0 };
    expect(await runSnapshotGcOnce(f.options)).toEqual(zero);
    writeFileSync(f.snapshotsRoot, "file");
    expect(await runSnapshotGcOnce(f.options)).toEqual(zero);
    rmSync(f.snapshotsRoot);
    symlinkSync(f.repoCacheRoot, f.snapshotsRoot);
    expect(await runSnapshotGcOnce(f.options)).toEqual(zero);
    for (const snapshotsRoot of [f.root, `${f.root}-outside`]) {
      await expect(runSnapshotGcOnce({ ...f.options, snapshotsRoot })).rejects.toThrow("must be inside");
    }
  });

  it("rejects unsafe cached snapshots without renewing their TTL so the sweep can reclaim them", async () => {
    const f = await snapshotFixture();
    const first = await f.create();
    const outsideFile = join(f.source, "README.md");
    const outsideMode = statSync(outsideFile).mode;
    chmodSync(first.path, 0o755);
    symlinkSync(outsideFile, join(first.path, "legacy-escape-link"));
    chmodSync(first.path, 0o555);
    age(first.path, Date.now() - ttlMs * 2);
    const originalMtime = statSync(first.path).mtimeMs;

    await expect(f.create()).rejects.toThrow("symlink escapes snapshot root");
    expect(statSync(first.path).mtimeMs).toBe(originalMtime);
    expect(statSync(first.path).mode & 0o777).toBe(0o555);
    expect(statSync(outsideFile).mode).toBe(outsideMode);
    expect(await runSnapshotGcOnce({ ...f.options, now: Date.now() }))
      .toEqual({ removed: 1, retained: 0, skipped: 0 });
    expect(existsSync(first.path)).toBe(false);
    expect(statSync(outsideFile).mode).toBe(outsideMode);
    expect(readFileSync(outsideFile, "utf8")).toBe("committed content\n");
  });

  it("refreshes reused snapshot access time so it survives the next sweep", async () => {
    const f = await snapshotFixture();
    const first = await f.create();
    expect(Date.now() - statSync(first.path).mtimeMs).toBeLessThan(ttlMs);
    age(first.path, Date.now() - ttlMs * 2);
    const before = Date.now();
    const reused = await f.create();
    expect(reused.created).toBe(false);
    expect(statSync(reused.path).mtimeMs).toBeGreaterThanOrEqual(before - 1);
    expect(await runSnapshotGcOnce({ ...f.options, now: Date.now() })).toEqual({ removed: 0, retained: 1, skipped: 0 });
    expect(readFileSync(join(reused.path, "README.md"), "utf8")).toBe("committed content\n");
  });

  it.each(["new", "reused"] as const)("rejects a %s snapshot when its access timestamp cannot be recorded", async (kind) => {
    const f = await snapshotFixture();
    if (kind === "reused") await f.create();
    const touch = spyOn(fs, "utimesSync").mockImplementation(() => {
      throw new Error("snapshot touch denied");
    });
    try {
      await expect(f.create()).rejects.toThrow("snapshot touch denied");
    } finally {
      touch.mockRestore();
    }
    // The failure must release the repository lock so preparation can retry.
    expect((await f.create()).created).toBe(false);
  });

  it("runs snapshot collection from daemon GC without changing the workspace summary", async () => {
    const f = fixture();
    const expired = f.tree("old", Date.now() - ttlMs * 2);
    const daemon = new MultiremiDaemon({
      serverUrl: "http://127.0.0.1:1",
      workspacesRoot: f.root,
      repoCacheRoot: f.repoCacheRoot,
      snapshotTtlMs: ttlMs,
    });
    expect(await daemon.runGcOnce()).toEqual({ cleaned: 0, orphaned: 0, skipped: 0 });
    expect(existsSync(expired)).toBe(false);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "multiremi-snapshot-gc-"));
  roots.push(root);
  const snapshotsRoot = join(root, ".snapshots");
  const repoCacheRoot = join(root, ".repos");
  const wsDir = join(snapshotsRoot, "workspace");
  const repoDir = join(wsDir, "repo.git");
  const barePath = join(repoCacheRoot, "workspace", "repo.git");
  mkdirSync(dirname(barePath), { recursive: true });
  const now = Date.now();
  const options: RunSnapshotGcOnceOptions = {
    workspacesRoot: root, snapshotsRoot, repoCacheRoot, ttlMs, now,
    withRepoLock: (path, fn) => withRepoCacheLock(path, fn, { timeoutMs: 10 }),
  };
  return {
    root, snapshotsRoot, repoCacheRoot, wsDir, repoDir, barePath, now, options,
    tree(name: string, mtime: number) {
      const path = join(repoDir, name);
      mkdirSync(join(path, "nested"), { recursive: true });
      writeFileSync(join(path, "nested", "file"), "snapshot");
      age(path, mtime);
      return path;
    },
  };
}

async function snapshotFixture() {
  const f = fixture();
  const source = join(f.root, "source");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd, stdio: "pipe",
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Snapshot Test", GIT_AUTHOR_EMAIL: "snapshot@example.test",
      GIT_COMMITTER_NAME: "Snapshot Test", GIT_COMMITTER_EMAIL: "snapshot@example.test",
    },
  });
  git(f.root, ["init", "-b", "main", source]);
  writeFileSync(join(source, "README.md"), "committed content\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "snapshot fixture"]);
  const cache = new MultiremiRepoCache(f.repoCacheRoot);
  await cache.sync("workspace", [{ url: source }]);
  return {
    ...f, source, cache,
    create: () => cache.createSnapshot({
      workspaceId: "workspace", repoUrl: source, snapshotsRoot: f.snapshotsRoot, skipFetch: true,
    }),
  };
}

function age(path: string, mtime: number): void {
  const date = new Date(mtime);
  utimesSync(path, date, date);
}

function makeWritable(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  chmodSync(path, info.mode | 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}
