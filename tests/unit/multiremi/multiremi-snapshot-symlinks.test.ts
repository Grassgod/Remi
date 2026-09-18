import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";

const roots: string[] = [];
const isolatedGitConfig = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};
let savedGitConfig: Record<string, string | undefined>;

beforeEach(() => {
  savedGitConfig = Object.fromEntries(Object.keys(isolatedGitConfig).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolatedGitConfig);
});

afterEach(() => {
  try {
    for (const root of roots.splice(0)) {
      // Never chmod through a link, including the intentionally cyclic links.
      makeDirectoriesWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    for (const [key, value] of Object.entries(savedGitConfig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

type SnapshotKind = "detached worktree" | "archive snapshot";

for (const kind of ["detached worktree", "archive snapshot"] as const) {
  describe(`${kind} symlink containment`, () => {
    it.each(["absolute file", "absolute directory", "relative parent", "link chain"] as const)(
      "rejects %s escape without changing the parent checkout or leaving a partial snapshot",
      async (escape) => {
        const f = await fixture(kind);
        const parentFile = join(f.parentPath, "README.md");
        const originalMode = statSync(parentFile).mode;
        const linkName = "escape-link";
        if (escape === "absolute file") {
          symlinkSync(parentFile, join(f.parentPath, linkName));
        } else if (escape === "absolute directory") {
          symlinkSync(f.parentPath, join(f.parentPath, linkName));
        } else if (escape === "relative parent") {
          const target = relative(f.snapshotPath(), parentFile);
          expect(target).toMatch(/^\.\.\/\.\.\//);
          symlinkSync(target, join(f.parentPath, linkName));
        } else {
          // The first two links appear internal lexically; only resolving the
          // complete chain exposes the external parent checkout target.
          symlinkSync("middle-hop", join(f.parentPath, linkName));
          symlinkSync("outside-hop", join(f.parentPath, "middle-hop"));
          symlinkSync(parentFile, join(f.parentPath, "outside-hop"));
        }
        f.commit();
        const registrations = git(f.barePath, ["worktree", "list", "--porcelain"]);

        // Directory enumeration order is platform dependent; every member of
        // this chain resolves outside, so any of its paths is a valid error.
        const offendingName = escape === "link chain" ? "(?:escape-link|middle-hop|outside-hop)" : linkName;
        await expect(f.create()).rejects.toThrow(new RegExp(`symlink escapes snapshot root: .*${offendingName}$`));

        expect(readFileSync(parentFile, "utf8")).toBe("parent checkout\n");
        expect(statSync(parentFile).mode).toBe(originalMode);
        expect(statSync(f.parentPath).mode & 0o200).toBe(0o200);
        expect(existsSync(f.snapshotPath())).toBe(false);
        expect(git(f.barePath, ["worktree", "list", "--porcelain"])).toBe(registrations);
        expect(f.leftoverSnapshots()).toEqual([]);
      },
    );

    it.each(["dangling", "cycle"] as const)("fails closed on a %s link and cleans its new tree", async (shape) => {
      const f = await fixture(kind);
      const linkName = "unresolved-link";
      symlinkSync(shape === "dangling" ? "missing-file" : "unresolved-link", join(f.parentPath, linkName));
      f.commit();
      const registrations = git(f.barePath, ["worktree", "list", "--porcelain"]);

      await expect(f.create()).rejects.toThrow(new RegExp(`cannot resolve .*symlink: .*${linkName}`));

      expect(existsSync(f.snapshotPath())).toBe(false);
      expect(git(f.barePath, ["worktree", "list", "--porcelain"])).toBe(registrations);
      expect(f.leftoverSnapshots()).toEqual([]);
    });

    it("preserves internal file, directory, parent-relative and chained links as readable but not writable", async () => {
      const f = await fixture(kind);
      mkdirSync(join(f.parentPath, "docs"));
      writeFileSync(join(f.parentPath, "docs", "guide.md"), "internal guide\n");
      const links = {
        "file-link": "README.md",
        "directory-link": "docs",
        "chain-link": "file-link",
        "docs/parent-link": "../README.md",
      };
      for (const [name, target] of Object.entries(links)) symlinkSync(target, join(f.parentPath, name));
      f.commit();

      const created = await f.create();

      expect(created.created).toBe(true);
      expect(created.path).toBe(f.snapshotPath());
      for (const [name, target] of Object.entries(links)) {
        expect(lstatSync(join(created.path, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(created.path, name))).toBe(target);
      }
      for (const name of ["file-link", "chain-link", "docs/parent-link"]) {
        expect(readFileSync(join(created.path, name), "utf8")).toBe("parent checkout\n");
        expect(statSync(join(created.path, name)).mode & 0o222).toBe(0);
        if (process.getuid?.() !== 0) {
          expect(() => writeFileSync(join(created.path, name), "write through link\n")).toThrow();
        }
      }
      expect(readFileSync(join(created.path, "directory-link", "guide.md"), "utf8")).toBe("internal guide\n");
      expect(statSync(join(created.path, "directory-link")).mode & 0o222).toBe(0);
      if (process.getuid?.() !== 0) {
        expect(() => writeFileSync(join(created.path, "directory-link", "guide.md"), "changed\n")).toThrow();
        expect(() => writeFileSync(join(created.path, "directory-link", "new.md"), "created\n")).toThrow();
      }
      if (kind === "detached worktree") {
        expect(git(created.path, ["status", "--porcelain"])).toBe("");
        expect(git(created.path, ["show", "HEAD:README.md"])).toBe("parent checkout");
      }
      expect(await f.create()).toMatchObject({ path: created.path, created: false });
    });

    it.each(["file", "directory"] as const)("rejects an escaping %s symlink when reusing a cached tree", async (targetKind) => {
      const f = await fixture(kind);
      const first = await f.create();
      const link = join(first.path, "legacy-escape-link");
      // Model a cache created before containment validation was introduced.
      chmodSync(first.path, 0o755);
      symlinkSync(targetKind === "file" ? join(f.parentPath, "README.md") : f.parentPath, link);
      chmodSync(first.path, 0o555);
      const parentMode = statSync(f.parentPath).mode;
      const fileMode = statSync(join(f.parentPath, "README.md")).mode;

      await expect(f.create()).rejects.toThrow(`symlink escapes snapshot root: ${link}`);

      expect(readFileSync(join(f.parentPath, "README.md"), "utf8")).toBe("parent checkout\n");
      expect(statSync(f.parentPath).mode).toBe(parentMode);
      expect(statSync(join(f.parentPath, "README.md")).mode).toBe(fileMode);
    });
  });
}

async function fixture(kind: SnapshotKind) {
  const root = mkdtempSync(join(tmpdir(), "multiremi-snapshot-symlinks-"));
  roots.push(root);
  const source = join(root, "source");
  git(root, ["init", "-b", "main", source]);
  writeFileSync(join(source, "README.md"), "parent checkout\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "initial"]);
  const cache = new MultiremiRepoCache(join(root, "cache"));
  await cache.sync("local", [{ url: source }]);
  const barePath = cache.lookup("local", source)!;
  const parentDir = join(root, "parent");
  mkdirSync(parentDir);
  const parentPath = cache.expectedWorktreePath(parentDir, source);
  const ref = "refs/heads/agent/MUL-324";
  git(barePath, ["worktree", "add", "-b", "agent/MUL-324", parentPath, "refs/remotes/origin/main"]);
  const workDir = join(root, "side");
  const snapshotsRoot = join(root, "snapshots");
  const repoSnapshotsRoot = join(snapshotsRoot, "local", basename(barePath));
  const snapshotPath = () => kind === "detached worktree"
    ? cache.expectedWorktreePath(workDir, source)
    : join(repoSnapshotsRoot, git(parentPath, ["rev-parse", "HEAD"]));
  const create = () => kind === "detached worktree"
    ? cache.createWorktree({ workspaceId: "local", repoUrl: source, workDir, ref, detach: true, skipFetch: true })
    : cache.createSnapshot({ workspaceId: "local", repoUrl: source, snapshotsRoot, ref, skipFetch: true });
  return {
    root, cache, barePath, parentPath, snapshotPath, create,
    commit() {
      git(parentPath, ["add", "--all"]);
      git(parentPath, ["commit", "-m", "snapshot symlink fixture"]);
    },
    leftoverSnapshots: () => kind === "detached worktree"
      ? (existsSync(workDir) ? readdirSync(workDir) : [])
      : (existsSync(repoSnapshotsRoot) ? readdirSync(repoSnapshotsRoot) : []),
  };
}

function makeDirectoriesWritable(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  chmodSync(path, info.mode | 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeDirectoriesWritable(join(path, entry.name));
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, ...isolatedGitConfig,
      GIT_AUTHOR_NAME: "Multiremi Test", GIT_AUTHOR_EMAIL: "multiremi@example.test",
      GIT_COMMITTER_NAME: "Multiremi Test", GIT_COMMITTER_EMAIL: "multiremi@example.test",
    },
  }).trim();
}
