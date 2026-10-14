import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EmbeddedRepositoryError,
  GitCheckFailedError,
  GitCommandError,
  SnapshotFailedError,
  SnapshotTooLargeError,
  assertSnapshotFits,
  commonGitDirectory,
  inspectUnsavedWork,
  isLinkedWorktree,
  pruneWorktrees,
  restoreSnapshot,
  runGit,
  snapshotWorktree,
  withoutRepositoryEnvironment,
} from "@daemon/agent-runtime/workspace/git-ops.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  // A host-level hook directory would slow every commit; these tests exercise git, not hooks.
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
  }).trim();
}

interface Fixture {
  root: string;
  bare: string;
  /** Worktree on `agent/MUL-1`, level with `origin/main`. */
  worktree: string;
  /** A worktree on a new branch from `origin/main`, or on an existing branch. */
  addWorktree(name: string, branch: string, existing?: boolean): string;
}

/** The shared repository's exclude file applies to every worktree, like the daemon's agent-file excludes. */
function ignore(f: Fixture, pattern: string): void {
  mkdirSync(join(f.bare, "info"), { recursive: true });
  writeFileSync(join(f.bare, "info", "exclude"), `${pattern}\n`, { flag: "a" });
}

/** A bare cache clone with an `origin` remote, like the daemon's shared repository. */
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-git-ops-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--initial-branch=main", source]);
  writeFileSync(join(source, "README.md"), "initial\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["push", origin, "main"]);
  const bare = join(root, "cache", "repo.git");
  mkdirSync(join(root, "cache"));
  git(root, ["clone", "--bare", origin, bare]);
  git(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(bare, ["fetch", "origin"]);
  git(bare, ["config", "multiremi.repository-url", "https://example.test/repo.git"]);
  const addWorktree = (name: string, branch: string, existing = false) => {
    const path = join(root, "work", name);
    mkdirSync(join(root, "work"), { recursive: true });
    git(bare, existing ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "origin/main"]);
    return path;
  };
  return { root, bare, worktree: addWorktree("MUL-1", "agent/MUL-1"), addWorktree };
}

describe("runGit", () => {
  test("returns output and rejects a failing command with its message", async () => {
    const f = fixture();
    expect((await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: f.worktree })).stdout.trim()).toBe("agent/MUL-1");
    await expect(runGit(["rev-parse", "--verify", "nope"], { cwd: f.worktree })).rejects.toBeInstanceOf(GitCommandError);
    const tolerated = await runGit(["rev-parse", "--verify", "nope"], { cwd: f.worktree, okExitCodes: [128] });
    expect(tolerated.exitCode).toBe(128);
  });

  test("a command that outlives its deadline is killed", async () => {
    const f = fixture();
    const started = Date.now();
    const error = await runGit(["-c", "alias.slow=!sleep 30", "slow"], { cwd: f.bare, timeoutMs: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(GitCommandError);
    expect((error as GitCommandError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("inspectUnsavedWork", () => {
  test("a clean worktree level with the remote has nothing to lose", async () => {
    const f = fixture();
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: false, unpushed: false });
  });

  test("modified and untracked files count as dirty, regardless of how many", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "README.md"), "changed\n");
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: true, unpushed: false });
    git(f.worktree, ["checkout", "--", "README.md"]);
    mkdirSync(join(f.worktree, "node_modules"));
    for (let i = 0; i < 12; i++) writeFileSync(join(f.worktree, "node_modules", `f${i}.js`), "x");
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: true, unpushed: false });
  });

  test("ignored files are rebuildable and do not count", async () => {
    const f = fixture();
    ignore(f, "dist/");
    mkdirSync(join(f.worktree, "dist"));
    writeFileSync(join(f.worktree, "dist", "out.js"), "built");
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: false, unpushed: false });
  });

  test("a commit no remote branch contains is unpushed work", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "local.txt"), "local\n");
    git(f.worktree, ["add", "local.txt"]);
    git(f.worktree, ["commit", "-m", "local"]);
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: false, unpushed: true });
  });

  test("a directory that is not a repository is a failed check, not clean", async () => {
    const f = fixture();
    const plain = join(f.root, "plain");
    mkdirSync(plain);
    await expect(inspectUnsavedWork(plain)).rejects.toBeInstanceOf(GitCheckFailedError);
  });

  test("a submodule with local changes is a failed check", async () => {
    const f = fixture();
    const library = join(f.root, "library");
    git(f.root, ["init", "--initial-branch=main", library]);
    writeFileSync(join(library, "lib.txt"), "lib\n");
    git(library, ["add", "."]);
    git(library, ["commit", "-m", "lib"]);
    git(f.worktree, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);
    git(f.worktree, ["commit", "-m", "add submodule"]);
    git(f.worktree, ["push", "origin", "HEAD:refs/heads/agent/MUL-1"]);
    git(f.bare, ["fetch", "origin"]);
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: false, unpushed: false });
    writeFileSync(join(f.worktree, "vendor", "lib", "lib.txt"), "edited\n");
    await expect(inspectUnsavedWork(f.worktree)).rejects.toThrow(/submodule has local changes/);
  });
});

/** A plain clone of the fixture's origin: its repository goes with its working tree. */
function cloneOf(f: Fixture, name = "clone"): string {
  const path = join(f.root, "work", name);
  mkdirSync(join(f.root, "work"), { recursive: true });
  git(f.root, ["clone", join(f.root, "origin.git"), path]);
  return path;
}

function commitIn(repository: string, file = "local.txt"): string {
  writeFileSync(join(repository, file), `${file}\n`);
  git(repository, ["add", file]);
  git(repository, ["commit", "-m", `add ${file}`]);
  return git(repository, ["rev-parse", "HEAD"]);
}

describe("inspectUnsavedWork of a repository that is deleted with its working tree", () => {
  test("a fresh clone and an empty repository have nothing to lose", async () => {
    const f = fixture();
    const empty = join(f.root, "work", "empty");
    mkdirSync(empty, { recursive: true });
    git(empty, ["init", "--initial-branch=main"]);
    expect(await inspectUnsavedWork(cloneOf(f), { allRefs: true })).toEqual({ dirty: false, unpushed: false });
    expect(await inspectUnsavedWork(empty, { allRefs: true })).toEqual({ dirty: false, unpushed: false });
    // An unborn HEAD has no commits to be unpushed, in either mode.
    expect(await inspectUnsavedWork(empty)).toEqual({ dirty: false, unpushed: false });
  });

  test("a commit on a branch the checkout has left is invisible to HEAD but not to the whole repository", async () => {
    const f = fixture();
    const clone = cloneOf(f);
    git(clone, ["checkout", "-b", "side"]);
    commitIn(clone);
    git(clone, ["checkout", "main"]);

    expect(await inspectUnsavedWork(clone)).toEqual({ dirty: false, unpushed: false });
    expect(await inspectUnsavedWork(clone, { allRefs: true })).toEqual({ dirty: false, unpushed: true });
  });

  test("a stash and a tag count", async () => {
    const f = fixture();
    const stashed = cloneOf(f, "stashed");
    writeFileSync(join(stashed, "README.md"), "stashed\n");
    git(stashed, ["stash"]);
    const tagged = cloneOf(f, "tagged");
    git(tagged, ["checkout", "--detach"]);
    commitIn(tagged);
    git(tagged, ["tag", "keep-me"]);
    git(tagged, ["checkout", "main"]);

    expect(await inspectUnsavedWork(stashed, { allRefs: true })).toEqual({ dirty: false, unpushed: true });
    expect(await inspectUnsavedWork(tagged, { allRefs: true })).toEqual({ dirty: false, unpushed: true });
  });

  test("a repository with a commit and no remote at all has unsaved work", async () => {
    const f = fixture();
    const local = join(f.root, "work", "local");
    mkdirSync(local, { recursive: true });
    git(local, ["init", "--initial-branch=main"]);
    commitIn(local);
    expect(await inspectUnsavedWork(local, { allRefs: true })).toEqual({ dirty: false, unpushed: true });
  });

  test("a scope leaves nested repositories and the daemon's entries out of the status", async () => {
    const f = fixture();
    const nested = join(f.worktree, "third_party", "lib");
    mkdirSync(join(f.worktree, "third_party"), { recursive: true });
    git(f.root, ["clone", join(f.root, "origin.git"), nested]);
    mkdirSync(join(f.worktree, ".multiremi"));
    writeFileSync(join(f.worktree, ".multiremi", "task.json"), "{}\n");

    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: true, unpushed: false });
    expect(await inspectUnsavedWork(f.worktree, { scope: { exclude: ["third_party/lib", ".multiremi"] } })).toEqual({ dirty: false, unpushed: false });
  });
});

describe("inspectUnsavedWork of a detached worktree", () => {
  test("is rebuildable at a branch's tip and at a pushed commit, but not at a commit nothing names", async () => {
    const f = fixture();
    const tip = commitIn(f.worktree);
    const atTip = join(f.root, "work", "at-tip");
    git(f.bare, ["worktree", "add", "--detach", atTip, tip]);
    const atMain = join(f.root, "work", "at-main");
    git(f.bare, ["worktree", "add", "--detach", atMain, "origin/main"]);
    const lost = join(f.root, "work", "lost");
    git(f.bare, ["worktree", "add", "--detach", lost, "origin/main"]);
    commitIn(lost, "lost.txt");

    expect(await inspectUnsavedWork(atTip)).toEqual({ dirty: false, unpushed: false });
    expect(await inspectUnsavedWork(atMain)).toEqual({ dirty: false, unpushed: false });
    expect(await inspectUnsavedWork(lost)).toEqual({ dirty: false, unpushed: true });
    // The branch itself still counts: its worktree is where those commits were made.
    expect(await inspectUnsavedWork(f.worktree)).toEqual({ dirty: false, unpushed: true });
  });
});

describe("a detached worktree and tags", () => {
  test("a tag does not make a detached commit safe: the repository cache prunes the tags no remote has", async () => {
    const f = fixture();
    const detached = join(f.root, "work", "detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    const head = commitIn(detached, "tagged-only.txt");
    git(detached, ["tag", "my-local-tag"]);

    expect(await inspectUnsavedWork(detached)).toEqual({ dirty: false, unpushed: true });
    const snapshot = await snapshotWorktree({ worktree: detached, subjectRef: "iss_3", maxBytes: 1 << 20 });

    expect(snapshot).toMatchObject({ commit: head, head, branch: null, ref: "refs/remi/snapshots/iss_3/1" });
    // What the cache's next sync does to a tag that origin does not have.
    git(f.bare, ["fetch", "--prune", "--prune-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
    expect(git(f.bare, ["tag", "--list", "my-local-tag"])).toBe("");
    expect(git(f.bare, ["for-each-ref", "--contains", head, "--format=%(refname)", "refs/remi"])).toBe("refs/remi/snapshots/iss_3/1");
  });

  test("a branch does: the commit is named by something the cache keeps", async () => {
    const f = fixture();
    const detached = join(f.root, "work", "detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    commitIn(detached, "kept.txt");
    git(detached, ["branch", "kept"]);

    expect(await inspectUnsavedWork(detached)).toEqual({ dirty: false, unpushed: false });
  });
});

describe("inspectUnsavedWork of a bare repository", () => {
  test("is judged by its commits alone, since git cannot run status without a work tree", async () => {
    const f = fixture();
    const backup = join(f.root, "work", "backup.git");
    git(f.root, ["init", "--bare", "--initial-branch=main", backup]);
    expect(await inspectUnsavedWork(backup, { bare: true })).toEqual({ dirty: false, unpushed: false });
    const clone = cloneOf(f);
    commitIn(clone);
    git(clone, ["push", backup, "HEAD:refs/heads/main"]);

    expect(await inspectUnsavedWork(backup, { bare: true })).toEqual({ dirty: false, unpushed: true });
    // Without the option it is not a work tree: a failed check, never "clean".
    await expect(inspectUnsavedWork(backup)).rejects.toBeInstanceOf(GitCheckFailedError);
  });

  test("remote-tracking refs of a remote inside the doomed directories prove nothing", async () => {
    const f = fixture();
    const store = join(f.root, "work", "store.git");
    git(f.root, ["init", "--bare", "--initial-branch=main", store]);
    const clone = cloneOf(f);
    git(clone, ["remote", "add", "backup", store]);
    git(clone, ["checkout", "-b", "side"]);
    commitIn(clone);
    git(clone, ["push", "backup", "side"]);

    expect(await inspectUnsavedWork(clone, { allRefs: true })).toEqual({ dirty: false, unpushed: false });
    expect(await inspectUnsavedWork(clone, { allRefs: true, doomed: [join(f.root, "work")] })).toEqual({ dirty: false, unpushed: true });
    // A directory that does not contain the remote leaves the answer alone.
    expect(await inspectUnsavedWork(clone, { allRefs: true, doomed: [join(f.root, "elsewhere")] })).toEqual({ dirty: false, unpushed: false });
  });
});

describe("snapshotWorktree", () => {
  test("nothing to save returns null and creates no ref", async () => {
    const f = fixture();
    expect(await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 })).toBeNull();
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
  });

  test("uncommitted and untracked work becomes one commit above HEAD, leaving the worktree untouched", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "README.md"), "edited\n");
    writeFileSync(join(f.worktree, "new.txt"), "brand new\n");
    const head = git(f.worktree, ["rev-parse", "HEAD"]);
    const indexBefore = git(f.worktree, ["status", "--porcelain=v1"]);

    const snapshot = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20, now: new Date("2026-10-13T00:00:00Z") });

    expect(snapshot).toMatchObject({
      repo_url: "https://example.test/repo.git", ref: "refs/remi/snapshots/iss_1/1", head, branch: "agent/MUL-1",
    });
    expect(snapshot!.commit).not.toBe(head);
    expect(git(f.bare, ["rev-parse", "refs/remi/snapshots/iss_1/1"])).toBe(snapshot!.commit);
    expect(git(f.bare, ["rev-parse", `${snapshot!.commit}^`])).toBe(head);
    expect(git(f.bare, ["show", `${snapshot!.commit}:new.txt`])).toBe("brand new");
    expect(git(f.bare, ["show", `${snapshot!.commit}:README.md`])).toBe("edited");
    expect(git(f.bare, ["log", "-1", "--format=%s", snapshot!.commit])).toBe("remi snapshot iss_1 2026-10-13T00:00:00.000Z");
    expect(git(f.worktree, ["status", "--porcelain=v1"])).toBe(indexBefore);
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("edited\n");
  });

  test("snapshot numbers count up per subject", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "a.txt"), "a");
    const first = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 });
    writeFileSync(join(f.worktree, "b.txt"), "b");
    const second = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 });
    const other = await snapshotWorktree({ worktree: f.worktree, subjectRef: "chat_1", maxBytes: 1 << 20 });
    expect([first!.ref, second!.ref, other!.ref]).toEqual([
      "refs/remi/snapshots/iss_1/1", "refs/remi/snapshots/iss_1/2", "refs/remi/snapshots/chat_1/1",
    ]);
  });

  test("unpushed commits are pinned by a ref without a new commit", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "local.txt"), "local\n");
    git(f.worktree, ["add", "local.txt"]);
    git(f.worktree, ["commit", "-m", "local"]);
    const head = git(f.worktree, ["rev-parse", "HEAD"]);
    const snapshot = await snapshotWorktree({ worktree: f.worktree, subjectRef: "legacy/MUL-9", maxBytes: 1 << 20 });
    expect(snapshot).toMatchObject({ ref: "refs/remi/snapshots/legacy/MUL-9/1", commit: head, head });
  });

  test("ignored files are not captured", async () => {
    const f = fixture();
    ignore(f, "build/");
    mkdirSync(join(f.worktree, "build"));
    writeFileSync(join(f.worktree, "build", "out.bin"), "x".repeat(4096));
    writeFileSync(join(f.worktree, "keep.txt"), "keep");
    const snapshot = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 });
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", snapshot!.commit]).split("\n")).toContain("keep.txt");
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", snapshot!.commit])).not.toContain("build/out.bin");
  });

  test("unsaved work beyond the budget is refused and leaves no ref", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "big.bin"), "x".repeat(5000));
    const error = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 4096 }).catch((e) => e);
    expect(error).toBeInstanceOf(SnapshotTooLargeError);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(existsSync(join(f.worktree, "big.bin"))).toBe(true);
  });

  test("a detached worktree records no branch", async () => {
    const f = fixture();
    const detached = join(f.root, "work", "detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    writeFileSync(join(detached, "x.txt"), "x");
    expect((await snapshotWorktree({ worktree: detached, subjectRef: "iss_2", maxBytes: 1 << 20 }))?.branch).toBeNull();
  });
});

describe("a snapshot never keeps only a pointer to a repository", () => {
  test("a repository nobody inspected is refused before anything is written: git would record a gitlink and drop its content", async () => {
    const f = fixture();
    const nested = join(f.worktree, "a", "b", "c", "lib");
    mkdirSync(join(f.worktree, "a", "b", "c"), { recursive: true });
    git(f.root, ["clone", join(f.root, "origin.git"), nested]);
    commitIn(nested);
    writeFileSync(join(f.worktree, "wip.txt"), "wip\n");

    await expect(assertSnapshotFits(f.worktree, 1 << 20)).rejects.toBeInstanceOf(EmbeddedRepositoryError);
    const error = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 }).catch((e) => e);

    expect(error).toBeInstanceOf(EmbeddedRepositoryError);
    expect(error).toBeInstanceOf(SnapshotFailedError);
    expect((error as EmbeddedRepositoryError).code).toBe("snapshot_failed");
    expect((error as EmbeddedRepositoryError).paths).toEqual([nested]);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(existsSync(join(nested, "local.txt"))).toBe(true);
  });

  test("the index decides in the end: a repository staged as a submodule HEAD does not have is refused too", async () => {
    const f = fixture();
    const library = join(f.root, "library");
    git(f.root, ["init", "--initial-branch=main", library]);
    commitIn(library, "lib.txt");
    git(f.worktree, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);
    // Staged, so status does not list it as an untracked directory.
    expect(git(f.worktree, ["status", "--porcelain=v1"])).toContain("A  vendor/lib");
    await assertSnapshotFits(f.worktree, 1 << 20);

    const error = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 }).catch((e) => e);

    expect(error).toBeInstanceOf(EmbeddedRepositoryError);
    expect((error as EmbeddedRepositoryError).paths).toEqual([join(f.worktree, "vendor", "lib")]);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(readdirSync(join(f.bare, "worktrees", "MUL-1")).filter((name) => name.endsWith(".index"))).toEqual([]);
  });

  test("a repository the scope leaves to its own check is no gitlink, and the rest is saved", async () => {
    const f = fixture();
    const nested = join(f.worktree, "third_party", "lib");
    mkdirSync(join(f.worktree, "third_party"), { recursive: true });
    git(f.root, ["clone", join(f.root, "origin.git"), nested]);
    writeFileSync(join(f.worktree, "wip.txt"), "wip\n");
    const scope = { exclude: ["third_party/lib"] };

    const snapshot = await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20, scope });

    expect(git(f.bare, ["ls-tree", "-r", "--name-only", snapshot!.commit]).split("\n").sort()).toEqual(["README.md", "wip.txt"]);
  });
});

describe("the environment a git child inherits", () => {
  const decoyVariables = (decoy: string, other: string) => ({
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(other, "index"),
    GIT_COMMON_DIR: join(decoy, ".git"),
    GIT_OBJECT_DIRECTORY: join(decoy, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoy, ".git", "objects"),
    GIT_NAMESPACE: "decoy",
    GIT_CEILING_DIRECTORIES: dirname(decoy),
  });

  test("a daemon started from a git hook judges the tree it is asked about, not the repository the hook was in", async () => {
    const f = fixture();
    const decoy = cloneOf(f, "decoy");
    writeFileSync(join(f.worktree, "wip.txt"), "wip\n");
    const clone = cloneOf(f, "unpushed");
    commitIn(clone);
    const snapshots: Array<{ commit: string } | null> = [];
    const results: unknown[] = [];
    const inherited = decoyVariables(decoy, f.root);
    Object.assign(process.env, inherited);
    try {
      results.push(await inspectUnsavedWork(f.worktree));
      results.push(await inspectUnsavedWork(clone, { allRefs: true }));
      results.push(await commonGitDirectory(f.worktree));
      snapshots.push(await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 }));
    } finally {
      for (const name of Object.keys(inherited)) delete process.env[name];
    }

    expect(results).toEqual([{ dirty: true, unpushed: false }, { dirty: false, unpushed: true }, f.bare]);
    expect(git(f.bare, ["show", `${snapshots[0]!.commit}:wip.txt`])).toBe("wip");
    expect(existsSync(join(f.root, "index"))).toBe(false);
  });

  test("what a caller sets explicitly is kept: the temporary index of a snapshot is the one variable it needs", async () => {
    const f = fixture();
    const decoy = cloneOf(f, "decoy");

    const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: f.worktree, env: { GIT_DIR: join(decoy, ".git") } });

    expect(gitDir.stdout.trim()).toBe(join(decoy, ".git"));
    const inherited = withoutRepositoryEnvironment({ PATH: "/bin", git_dir: "x", GIT_DIR: "y", GIT_INDEX_FILE: "z", GIT_AUTHOR_NAME: "kept" });
    expect(inherited).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "kept" });
  });
});

describe("restoreSnapshot", () => {
  async function snapshotAndRecreate(f: Fixture) {
    writeFileSync(join(f.worktree, "README.md"), "edited\n");
    writeFileSync(join(f.worktree, "new.txt"), "brand new\n");
    git(f.worktree, ["add", "README.md"]);
    git(f.worktree, ["commit", "-m", "committed locally"]);
    writeFileSync(join(f.worktree, "README.md"), "edited again\n");
    writeFileSync(join(f.worktree, "untracked.txt"), "untracked\n");
    const snapshot = (await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 }))!;
    git(f.bare, ["worktree", "remove", "--force", f.worktree]);
    expect(existsSync(f.worktree)).toBe(false);
    // The branch stays in the shared repository; the next execution re-adds the worktree on it.
    git(f.bare, ["branch", "-f", "agent/MUL-1", "origin/main"]);
    const fresh = f.addWorktree("MUL-1", "agent/MUL-1", true);
    return { snapshot, fresh };
  }

  test("a fresh worktree is fast-forwarded and the unsaved work comes back uncommitted", async () => {
    const f = fixture();
    const { snapshot, fresh } = await snapshotAndRecreate(f);

    const result = await restoreSnapshot(fresh, snapshot);

    expect(result).toEqual({ status: "restored", ref: snapshot.ref });
    expect(git(fresh, ["rev-parse", "HEAD"])).toBe(snapshot.head);
    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("edited again\n");
    expect(readFileSync(join(fresh, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(git(fresh, ["status", "--porcelain=v1"]).split("\n").map((line) => line.trim()).sort())
      .toEqual(["?? new.txt", "?? untracked.txt", "M README.md"]);
  });

  test("restoring unpushed commits alone fast-forwards to them", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "local.txt"), "local\n");
    git(f.worktree, ["add", "."]);
    git(f.worktree, ["commit", "-m", "local"]);
    const snapshot = (await snapshotWorktree({ worktree: f.worktree, subjectRef: "iss_1", maxBytes: 1 << 20 }))!;
    git(f.bare, ["worktree", "remove", "--force", f.worktree]);
    git(f.bare, ["branch", "-f", "agent/MUL-1", "origin/main"]);
    const fresh = f.addWorktree("MUL-1", "agent/MUL-1", true);
    expect(await restoreSnapshot(fresh, snapshot)).toEqual({ status: "restored", ref: snapshot.ref });
    expect(git(fresh, ["rev-parse", "HEAD"])).toBe(snapshot.head);
    expect(git(fresh, ["status", "--porcelain=v1"])).toBe("");
  });

  test("a worktree that diverged from the snapshot is left alone", async () => {
    const f = fixture();
    const { snapshot, fresh } = await snapshotAndRecreate(f);
    writeFileSync(join(fresh, "other.txt"), "other\n");
    git(fresh, ["add", "."]);
    git(fresh, ["commit", "-m", "diverge"]);
    const before = git(fresh, ["rev-parse", "HEAD"]);

    expect(await restoreSnapshot(fresh, snapshot)).toEqual({ status: "diverged", ref: snapshot.ref });
    expect(git(fresh, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(f.bare, ["rev-parse", snapshot.ref])).toBe(snapshot.commit);
  });

  test("a worktree with its own uncommitted changes is not overwritten", async () => {
    const f = fixture();
    const { snapshot, fresh } = await snapshotAndRecreate(f);
    writeFileSync(join(fresh, "mine.txt"), "mine\n");
    expect((await restoreSnapshot(fresh, snapshot)).status).toBe("dirty");
    expect(readFileSync(join(fresh, "mine.txt"), "utf8")).toBe("mine\n");
  });

  test("a worktree of another repository takes nothing, even when its HEAD is an ancestor", async () => {
    const f = fixture();
    const { snapshot } = await snapshotAndRecreate(f);
    const other = join(f.root, "cache", "other.git");
    git(f.root, ["clone", "--bare", join(f.root, "origin.git"), other]);
    git(other, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(other, ["fetch", "origin"]);
    const foreign = join(f.root, "work", "foreign");
    git(other, ["worktree", "add", "-b", "agent/MUL-1", foreign, "origin/main"]);

    expect(await restoreSnapshot(foreign, snapshot)).toEqual({ status: "missing", ref: snapshot.ref });
    expect(git(foreign, ["status", "--porcelain=v1"])).toBe("");
  });

  test("a worktree on another branch than the snapshot was taken on takes nothing: that branch would move onto work never made there", async () => {
    const f = fixture();
    const { snapshot } = await snapshotAndRecreate(f);
    const other = join(f.root, "work", "other");
    git(f.bare, ["worktree", "add", "-b", "agent/other", other, "origin/main"]);
    const before = git(other, ["rev-parse", "HEAD"]);

    expect(await restoreSnapshot(other, snapshot)).toEqual({ status: "other_branch", ref: snapshot.ref });
    expect(git(other, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(f.bare, ["rev-parse", "refs/heads/agent/other"])).toBe(before);
    expect(git(other, ["status", "--porcelain=v1"])).toBe("");
  });

  test("a detached worktree takes the snapshot only at the snapshot's HEAD", async () => {
    const f = fixture();
    const { snapshot } = await snapshotAndRecreate(f);
    const atMain = join(f.root, "work", "at-main");
    git(f.bare, ["worktree", "add", "--detach", atMain, "origin/main"]);
    const atHead = join(f.root, "work", "at-head");
    git(f.bare, ["worktree", "add", "--detach", atHead, snapshot.head]);

    expect((await restoreSnapshot(atMain, snapshot)).status).toBe("other_branch");
    expect(await restoreSnapshot(atHead, snapshot)).toEqual({ status: "restored", ref: snapshot.ref });
    expect(readFileSync(join(atHead, "untracked.txt"), "utf8")).toBe("untracked\n");
  });

  test("a snapshot of a detached worktree names no branch, so it is not held to one", async () => {
    const f = fixture();
    const detached = join(f.root, "work", "detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    writeFileSync(join(detached, "x.txt"), "x\n");
    const snapshot = (await snapshotWorktree({ worktree: detached, subjectRef: "iss_2", maxBytes: 1 << 20 }))!;
    git(f.bare, ["worktree", "remove", "--force", detached]);
    const fresh = f.addWorktree("fresh", "agent/anything");

    expect((await restoreSnapshot(fresh, snapshot)).status).toBe("restored");
  });

  test("a snapshot whose objects are gone reports missing", async () => {
    const f = fixture();
    const { fresh } = await snapshotAndRecreate(f);
    const status = await restoreSnapshot(fresh, {
      repo_url: "x", ref: "refs/remi/snapshots/iss_1/9", commit: "1".repeat(40), head: "1".repeat(40), branch: null,
    });
    expect(status.status).toBe("missing");
  });
});

describe("worktree maintenance", () => {
  test("a linked worktree is recognised and resolves to its shared repository", async () => {
    const f = fixture();
    expect(await isLinkedWorktree(f.worktree)).toBe(true);
    expect(await commonGitDirectory(f.worktree)).toBe(f.bare);
    rmSync(f.worktree, { recursive: true, force: true });
    expect(await isLinkedWorktree(f.worktree)).toBe(false);
  });

  test("prune drops registrations of directories that disappeared", async () => {
    const f = fixture();
    rmSync(f.worktree, { recursive: true, force: true });
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain("MUL-1");
    await pruneWorktrees(f.bare);
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain("MUL-1");
  });
});
