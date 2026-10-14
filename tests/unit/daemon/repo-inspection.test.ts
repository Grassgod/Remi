import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedReposRoot } from "@daemon/agent-runtime/workspace/layout.js";
import { pruneWorktrees } from "@daemon/agent-runtime/workspace/git-ops.js";
import {
  REPOSITORY_SEARCH_DEPTH,
  discoverRepositories,
  inspectTree,
  listLinkedWorktrees,
  repairCopiedWorktrees,
  repairMovedWorktrees,
  sharedRepositories,
  snapshotTree,
  treeBlocker,
  type InspectedRepository,
  type TreeInspection,
} from "@daemon/agent-runtime/workspace/repo-inspection.js";
import { cleanupFixtures, git, localRepositoryAt, reclaimFixture, type ReclaimFixture } from "./reclaim-fixture.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);
afterEach(cleanupFixtures);

const BIG = 1 << 30;

/** A tree below the fixture's scratch directory, and the options that make the fixture's bare repository the shared cache. */
function treeOf(f: ReclaimFixture) {
  const tree = join(f.scratch, "tree");
  mkdirSync(tree, { recursive: true });
  return {
    tree,
    options: { cacheRoots: [sharedReposRoot(f.root)], maxBytes: BIG },
    /** A linked worktree of the shared bare repository. */
    linked(relative: string, branch: string): string {
      const path = join(tree, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      git(f.bare, ["worktree", "add", "-b", branch, path, "origin/main"]);
      return path;
    },
    /** A plain clone of the origin: its `.git` is a directory. */
    clone(relative: string): string {
      const path = join(tree, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      git(f.scratch, ["clone", join(f.scratch, "origin.git"), path]);
      return path;
    },
  };
}

function commit(repository: string, file = "local.txt"): string {
  writeFileSync(join(repository, file), `${file}\n`);
  git(repository, ["add", file]);
  git(repository, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", `add ${file}`]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function byRelative(inspection: TreeInspection): Record<string, InspectedRepository> {
  return Object.fromEntries(inspection.repositories.map((repository) => [repository.relative, repository]));
}

describe("discovering repositories", () => {
  test("finds the tree itself, its children and repositories inside other repositories, parents first", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    git(t.tree, ["init", "--initial-branch=main", t.tree]);
    t.linked("repo", "agent/a");
    t.clone("repo/vendor/lib");
    t.clone("other");
    t.linked("repo-experiment", "agent/b");

    const { repositories, unsearchable } = await discoverRepositories(t.tree);

    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["", "other", "repo", "repo/vendor/lib", "repo-experiment"]);
    expect(unsearchable).toEqual([]);
  });

  test("searches the tree and six levels below it, no deeper", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const levels = (depth: number) => Array.from({ length: depth }, (_, index) => `d${index + 1}`).join("/");
    t.clone(`${levels(REPOSITORY_SEARCH_DEPTH)}/inside`.replace("/inside", ""));
    t.clone(`${levels(REPOSITORY_SEARCH_DEPTH + 1)}`);

    const { repositories } = await discoverRepositories(t.tree);

    expect(REPOSITORY_SEARCH_DEPTH).toBe(6);
    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual([levels(6)]);
    expect((await discoverRepositories(t.tree, { maxDepth: 7 })).repositories).toHaveLength(2);
  });

  test("never goes through links, into .git or node_modules, or into names it was told to skip", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const outside = join(f.scratch, "outside");
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), outside]);
    symlinkSync(outside, join(t.tree, "linked"), "dir");
    t.clone("node_modules/dependency");
    t.clone("skipped/lib");
    t.clone("kept");
    // A repository's own .git directory holds modules and worktrees that must not be mistaken for repositories.
    mkdirSync(join(t.tree, "kept", ".git", "modules", "x", ".git"), { recursive: true });

    const { repositories } = await discoverRepositories(t.tree, { skip: (_directory, name) => name === "skipped" });

    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["kept"]);
  });

  test("the daemon's own directories are searched like any other: an agent can leave a repository there too", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.clone("wiki/notes/repo");
    t.clone(".multiremi/scratch");

    const inspection = await inspectTree(t.tree, { ...t.options, daemonEntries: new Set(["wiki", ".multiremi"]) });

    expect(inspection.repositories.map((repository) => repository.relative)).toEqual([".multiremi/scratch", "wiki/notes/repo"]);
  });

  test("a .git of any kind counts: a file, a directory or a link", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    mkdirSync(join(t.tree, "file"));
    writeFileSync(join(t.tree, "file", ".git"), "gitdir: /nowhere\n");
    mkdirSync(join(t.tree, "directory", ".git"), { recursive: true });
    mkdirSync(join(t.tree, "link"));
    symlinkSync(join(f.scratch, "elsewhere.git"), join(t.tree, "link", ".git"));

    const { repositories } = await discoverRepositories(t.tree);

    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["directory", "file", "link"]);
  });

  test("a bare repository is found although it has no .git, and what git keeps inside it is not searched", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    // Where a bare repository keeps its linked worktrees' records, and a stray directory that looks like a repository.
    t.clone("store.git/worktrees/odd");
    mkdirSync(join(t.tree, "plain", "refs"), { recursive: true });
    mkdirSync(join(t.tree, "plain", "objects"), { recursive: true });
    t.clone("plain/clone");

    const { repositories, bare } = await discoverRepositories(t.tree);

    expect(bare).toEqual([store]);
    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["plain/clone", "store.git"]);
  });

  test("a bare repository whose HEAD is a link, as git still allows, is found too", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "legacy.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    rmSync(join(store, "HEAD"));
    symlinkSync("refs/heads/main", join(store, "HEAD"));

    const { bare } = await discoverRepositories(t.tree);

    expect(bare).toEqual([store]);
  });

  test("a worktree added inside a bare repository is found: its work is in no commit the bare repository could be judged by", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), store]);
    git(store, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(store, ["fetch", "origin"]);
    // `cd store.git && git worktree add feature`
    git(store, ["worktree", "add", "-b", "feature", "feature", "origin/main"]);
    writeFileSync(join(store, "feature", "design.md"), "uncommitted design work\n");

    const inspection = await inspectTree(t.tree, t.options);

    const found = byRelative(inspection);
    expect(Object.keys(found)).toEqual(["store.git", "store.git/feature"]);
    expect(found["store.git"]).toMatchObject({ bare: true, kind: "standalone", unsaved: false });
    expect(found["store.git/feature"]).toMatchObject({ bare: false, kind: "standalone", unsaved: true, blocker: { reason: "snapshot_failed" } });
    expect(treeBlocker(inspection)).toEqual({ reason: "snapshot_failed", message: expect.stringContaining(join("store.git", "feature")) });
  });

  test("a tree that is missing has no repositories", async () => {
    const f = reclaimFixture();
    expect(await discoverRepositories(join(f.scratch, "gone"))).toEqual({ repositories: [], bare: [], unsearchable: [] });
  });

  test("a directory is not entered when the skip rule says so, judged by where it stands", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.clone("generation/home/clone");
    t.clone("generation/work/home/clone");

    const { repositories } = await discoverRepositories(t.tree, {
      skip: (directory, name) => name === "home" && directory === join(t.tree, "generation"),
    });

    // `home` directly below the generation is skipped; the one inside `work` is not.
    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["generation/work/home/clone"]);
  });

  // Root reads any directory, so there is nothing to refuse there.
  test.skipIf(process.getuid?.() === 0)("a directory that cannot be listed is reported, and the rest is still searched", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.clone("a/clone");
    const locked = join(t.tree, "b", "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const { repositories, unsearchable } = await discoverRepositories(t.tree);

      expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["a/clone"]);
      expect(unsearchable).toEqual([{ path: locked, message: expect.stringContaining("EACCES") }]);
      expect(treeBlocker({ tree: t.tree, repositories: [], unsearchable })).toEqual({
        reason: "git_check_failed",
        message: expect.stringContaining(`cannot search ${locked} for repositories`),
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("classifying repositories", () => {
  test("a worktree of a bare repository in the cache is shared-linked, anything else is standalone", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const linked = t.linked("linked", "agent/a");
    const clone = t.clone("clone");
    git(clone, ["worktree", "add", "-b", "feature", join(t.tree, "clone-worktree"), "origin/main"]);
    t.linked("linked/sibling", "agent/b");

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["linked"]).toMatchObject({ kind: "shared-linked", path: linked, commonDir: f.bare, blocker: null });
    expect(found["linked/sibling"]).toMatchObject({ kind: "shared-linked", commonDir: f.bare });
    expect(found["clone"]).toMatchObject({ kind: "standalone", commonDir: join(clone, ".git") });
    // Its .git is a file too, but the repository behind it is the clone inside the tree.
    expect(found["clone-worktree"]).toMatchObject({ kind: "standalone", commonDir: join(clone, ".git") });
  });

  test("a submodule of a linked worktree is standalone: its git directory is pruned with the worktree", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const library = join(f.scratch, "library");
    git(f.scratch, ["init", "--initial-branch=main", library]);
    commit(library, "lib.txt");
    const repo = t.linked("repo", "agent/a");
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["repo/vendor/lib"]).toMatchObject({ kind: "standalone" });
    expect(found["repo/vendor/lib"]!.commonDir).toContain(join(f.bare, "worktrees"));
  });

  test("checking several repositories at once changes nothing about the result or its order", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    for (let index = 0; index < 6; index++) {
      const path = t.linked(`worktree-${index}`, `agent/${index}`);
      if (index % 2) writeFileSync(join(path, "wip.txt"), "wip\n");
    }
    t.clone("clone");

    const serial = await inspectTree(t.tree, t.options);
    const parallel = await inspectTree(t.tree, { ...t.options, concurrency: 4 });

    expect(parallel).toEqual(serial);
    expect(parallel.repositories.map((repository) => repository.relative)).toEqual([
      "clone", "worktree-0", "worktree-1", "worktree-2", "worktree-3", "worktree-4", "worktree-5",
    ]);
  });

  test.each([
    ["directly in the cache", "repo.git"],
    ["several levels down in the cache", "a/b/c/repo.git"],
  ])("a bare repository %s is a shared repository wherever it lies", async (_name, relative) => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const cache = join(f.scratch, "other-cache");
    const bare = join(cache, ...relative.split("/"));
    mkdirSync(join(bare, ".."), { recursive: true });
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), bare]);
    git(bare, ["worktree", "add", join(t.tree, "linked"), "main"]);

    const inspection = await inspectTree(t.tree, { ...t.options, cacheRoots: [cache] });

    expect(inspection.repositories[0]).toMatchObject({ kind: "shared-linked", commonDir: bare });
  });

  test("a cache that does not exist holds no repository", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");

    const inspection = await inspectTree(t.tree, { ...t.options, cacheRoots: [join(f.scratch, "no-cache")] });

    expect(inspection.repositories[0]).toMatchObject({ kind: "standalone", unsaved: false, blocker: null });
  });

  test("a cache reached through a link is still recognised", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    symlinkSync(sharedReposRoot(f.root), join(f.scratch, "cache-link"), "dir");

    const inspection = await inspectTree(t.tree, { ...t.options, cacheRoots: [join(f.scratch, "cache-link")] });

    expect(inspection.repositories[0]).toMatchObject({ kind: "shared-linked" });
  });

  test("a .git git cannot read blocks the tree as a failed check", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    mkdirSync(join(t.tree, "broken"));
    writeFileSync(join(t.tree, "broken", ".git"), "gitdir: /nonexistent/place\n");

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories[0]).toMatchObject({ kind: null, commonDir: null, unsaved: false });
    expect(treeBlocker(inspection)).toEqual({ reason: "git_check_failed", message: expect.stringContaining("cannot inspect") });
  });
});

describe("unsaved work", () => {
  test("a clean clone, a clean worktree and an empty repository have none", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.clone("clone");
    t.linked("worktree", "agent/a");
    git(f.scratch, ["init", "--initial-branch=main", join(t.tree, "empty")]);

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories.map((repository) => [repository.relative, repository.unsaved, repository.blocker])).toEqual([
      ["clone", false, null],
      ["empty", false, null],
      ["worktree", false, null],
    ]);
    expect(treeBlocker(inspection)).toBeNull();
  });

  test.each([
    ["an untracked file", (clone: string) => { writeFileSync(join(clone, "wip.txt"), "wip\n"); }],
    ["a modified file", (clone: string) => { writeFileSync(join(clone, "README.md"), "edited\n"); }],
    ["a commit on the checked-out branch", (clone: string) => { commit(clone); }],
    ["a commit on a side branch the checkout has left", (clone: string) => {
      git(clone, ["checkout", "-b", "side"]);
      commit(clone);
      git(clone, ["checkout", "main"]);
    }],
    ["a commit only a detached HEAD has", (clone: string) => {
      git(clone, ["checkout", "--detach"]);
      commit(clone);
    }],
    ["a stash", (clone: string) => {
      writeFileSync(join(clone, "README.md"), "stashed\n");
      git(clone, ["stash"]);
    }],
    ["a tag on a commit no remote has", (clone: string) => {
      git(clone, ["checkout", "--detach"]);
      commit(clone);
      git(clone, ["tag", "keep-me"]);
      git(clone, ["checkout", "main"]);
    }],
  ])("a standalone clone with %s keeps the tree", async (_name, edit) => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const clone = t.clone("clone");
    edit(clone);

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories[0]).toMatchObject({ kind: "standalone", unsaved: true });
    expect(treeBlocker(inspection)).toEqual({
      reason: "snapshot_failed",
      message: expect.stringContaining("standalone clone with unsaved work"),
    });
  });

  test("a repository without any remote and with a commit has unsaved work; without a commit it has none", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const local = join(t.tree, "local");
    git(f.scratch, ["init", "--initial-branch=main", local]);
    const bare = join(t.tree, "untouched");
    git(f.scratch, ["init", "--initial-branch=main", bare]);
    commit(local);

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["local"]).toMatchObject({ unsaved: true, blocker: { reason: "snapshot_failed" } });
    expect(found["untouched"]).toMatchObject({ unsaved: false, blocker: null });
  });

  test("a linked worktree's unsaved work can be saved, so it blocks nothing", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const dirty = t.linked("dirty", "agent/a");
    writeFileSync(join(dirty, "wip.txt"), "wip\n");
    commit(t.linked("ahead", "agent/b"));

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories.map((repository) => [repository.relative, repository.unsaved, repository.blocker])).toEqual([
      ["ahead", true, null],
      ["dirty", true, null],
    ]);
  });

  test("a linked worktree whose unsaved work exceeds the limit blocks the tree", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    writeFileSync(join(t.linked("big", "agent/a"), "big.bin"), Buffer.alloc(4096, 1));

    const inspection = await inspectTree(t.tree, { ...t.options, maxBytes: 1024 });

    expect(treeBlocker(inspection)).toEqual({ reason: "snapshot_failed", message: expect.stringContaining("snapshot limit") });
  });

  test("a read-only detached worktree at a branch tip is rebuildable; one at a commit nothing else names is not", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const issue = t.linked("issue", "agent/a");
    const tip = commit(issue);
    git(f.bare, ["worktree", "add", "--detach", join(t.tree, "discussion"), tip]);
    const lost = join(t.tree, "lost");
    git(f.bare, ["worktree", "add", "--detach", lost, "origin/main"]);
    commit(lost, "lost.txt");

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["issue"]).toMatchObject({ unsaved: true });
    expect(found["discussion"]).toMatchObject({ unsaved: false });
    expect(found["lost"]).toMatchObject({ unsaved: true });
  });
});

describe("each repository on its own", () => {
  test("a parent leaves the repositories nested in it, and the daemon's entries, out of its own check", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    git(f.bare, ["worktree", "add", "-b", "chat/a", t.tree, "origin/main"]);
    mkdirSync(join(t.tree, ".multiremi"));
    writeFileSync(join(t.tree, ".multiremi", "task.json"), "{}\n");
    mkdirSync(join(t.tree, "wiki"));
    writeFileSync(join(t.tree, "wiki", "page.md"), "page\n");
    t.clone("third_party/lib");
    t.linked("tools/helper", "chat/b");

    const found = byRelative(await inspectTree(t.tree, { ...t.options, daemonEntries: new Set(["wiki", ".multiremi"]) }));

    expect(found["."]).toMatchObject({ kind: "shared-linked", unsaved: false });
    expect(found["."]!.scope!.exclude).toEqual(["wiki", ".multiremi", "third_party/lib", "tools/helper"]);
    expect(found["third_party/lib"]).toMatchObject({ kind: "standalone", unsaved: false });
    expect(found["tools/helper"]!.scope).toBeUndefined();
  });

  test("a nested clone's unsaved work blocks the tree although its parent is clean and does not see it", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const repo = t.linked("repo", "agent/a");
    const nested = t.clone("repo/third_party/lib");
    commit(nested);
    // The parent's own status shows the nested repository as an untracked directory; its scope leaves it out.
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("?? third_party/");

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["repo"]).toMatchObject({ unsaved: false, blocker: null });
    expect(found["repo/third_party/lib"]).toMatchObject({ unsaved: true, blocker: { reason: "snapshot_failed" } });
  });

  test("a nested clone the parent ignores is found all the same", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    commit(t.clone("repo/scratch/lib"));
    mkdirSync(join(f.bare, "info"), { recursive: true });
    writeFileSync(join(f.bare, "info", "exclude"), "scratch/\n");

    const inspection = await inspectTree(t.tree, t.options);

    expect(treeBlocker(inspection)).toEqual({ reason: "snapshot_failed", message: expect.stringContaining(join("scratch", "lib")) });
  });

  test("a dirty submodule is a standalone repository with unsaved work, not a failed check", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const library = join(f.scratch, "library");
    git(f.scratch, ["init", "--initial-branch=main", library]);
    commit(library, "lib.txt");
    const repo = t.linked("repo", "agent/a");
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "add submodule"]);
    git(repo, ["push", "origin", "HEAD:refs/heads/agent/a"]);
    git(f.bare, ["fetch", "origin"]);
    writeFileSync(join(repo, "vendor", "lib", "lib.txt"), "edited\n");

    const inspection = await inspectTree(t.tree, t.options);

    expect(byRelative(inspection)["repo"]).toMatchObject({ unsaved: false, blocker: null });
    expect(treeBlocker(inspection)).toEqual({ reason: "snapshot_failed", message: expect.stringContaining(join("vendor", "lib")) });
  });
});

describe("bare repositories and remotes that go with the tree", () => {
  const origin = (f: ReclaimFixture) => join(f.scratch, "origin.git");

  test("a bare repository is standalone and judged by its commits alone: no work tree to run status in", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    git(f.scratch, ["init", "--bare", "--initial-branch=main", join(t.tree, "empty.git")]);
    const backup = join(t.tree, "backup.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", backup]);
    commit(t.clone("work"));
    git(join(t.tree, "work"), ["push", backup, "HEAD:refs/heads/main"]);
    const mirrored = join(t.tree, "mirrored.git");
    git(f.scratch, ["clone", "--bare", origin(f), mirrored]);
    git(mirrored, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(mirrored, ["fetch", "origin"]);

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["empty.git"]).toMatchObject({ bare: true, kind: "standalone", commonDir: join(t.tree, "empty.git"), unsaved: false, blocker: null });
    expect(found["mirrored.git"]).toMatchObject({ bare: true, kind: "standalone", unsaved: false, blocker: null });
    expect(found["backup.git"]).toMatchObject({
      bare: true, kind: "standalone", unsaved: true,
      blocker: { reason: "snapshot_failed", message: expect.stringContaining("standalone bare repository with unsaved work") },
    });
    expect(found["work"]).toMatchObject({ bare: false });
  });

  test("a clone whose remote is a repository of the tree has no remote that outlives it", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    const project = join(t.tree, "project");
    git(t.tree, ["clone", store, project]);
    git(project, ["checkout", "-b", "main"]);
    commit(project);
    // Pushed, so its remote-tracking ref has the commit; the remote dies with the tree all the same.
    git(project, ["push", "origin", "main"]);
    expect(git(project, ["rev-list", "--remotes", "-n1"])).not.toBe("");

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["project"]).toMatchObject({ unsaved: true, blocker: { reason: "snapshot_failed" } });
    expect(found["store.git"]).toMatchObject({ unsaved: true, blocker: { reason: "snapshot_failed" } });
  });

  test("a remote that outlives the tree still proves a commit is elsewhere, however the clone was made", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const project = t.clone("project");
    git(project, ["checkout", "-b", "pushed"]);
    commit(project);
    git(project, ["push", "origin", "pushed"]);
    // The same remote by a file:// URL and through a link.
    const viaUrl = t.clone("via-url");
    git(viaUrl, ["remote", "set-url", "origin", `file://${origin(f)}`]);
    const viaLink = t.clone("via-link");
    symlinkSync(origin(f), join(f.scratch, "origin-link.git"), "dir");
    git(viaLink, ["remote", "set-url", "origin", join(f.scratch, "origin-link.git")]);

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories.map((repository) => [repository.relative, repository.unsaved])).toEqual([
      ["project", false], ["via-link", false], ["via-url", false],
    ]);
  });

  test("a remote of the tree is found by a relative path, a file:// URL or a link, and after it was deleted", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    const via = (relative: string, url: string) => {
      const repository = join(t.tree, relative);
      git(f.scratch, ["clone", origin(f), repository]);
      commit(repository);
      git(repository, ["remote", "set-url", "origin", url]);
      // The tracking ref a push would have left behind.
      git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    };
    via("relative", "../store.git");
    via("file-url", `file://${store}`);
    symlinkSync(store, join(f.scratch, "store-link.git"), "dir");
    via("link", join(f.scratch, "store-link.git"));
    via("gone", join(t.tree, "deleted", "store.git"));

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories.filter((repository) => repository.kind === "standalone" && !repository.bare).map((repository) => [repository.relative, repository.unsaved])).toEqual([
      ["file-url", true], ["gone", true], ["link", true], ["relative", true],
    ]);
  });

  test("only the remotes that die with the tree are set aside: a commit another remote has is still elsewhere", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    const project = t.clone("project");
    git(project, ["remote", "add", "backup", store]);
    git(project, ["checkout", "-b", "both"]);
    commit(project, "both.txt");
    git(project, ["push", "origin", "both"]);
    git(project, ["push", "backup", "both"]);
    expect(git(project, ["for-each-ref", "refs/remotes/backup"])).not.toBe("");
    const alone = t.clone("alone");
    git(alone, ["remote", "add", "backup", store]);
    git(alone, ["checkout", "-b", "only-backup"]);
    commit(alone, "only-backup.txt");
    git(alone, ["push", "backup", "only-backup"]);

    const found = byRelative(await inspectTree(t.tree, t.options));

    expect(found["project"]).toMatchObject({ unsaved: false });
    expect(found["alone"]).toMatchObject({ unsaved: true });
  });

  test("the doomed directories are the tree by default, and can name more than the tree", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const sibling = join(f.scratch, "sibling");
    mkdirSync(sibling);
    const store = join(sibling, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    const project = t.clone("project");
    git(project, ["remote", "set-url", "origin", store]);
    commit(project);
    git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const alone = await inspectTree(t.tree, t.options);
    const together = await inspectTree(t.tree, { ...t.options, doomed: [t.tree, sibling] });

    expect(alone.repositories[0]).toMatchObject({ unsaved: false });
    expect(together.repositories[0]).toMatchObject({ unsaved: true });
  });
});

describe("directories laid out like a git directory", () => {
  /** What the layout alone suggests: a `HEAD` file, `objects/` and `refs/`. A folder of notes on git internals has all three. */
  function lookalike(directory: string): void {
    mkdirSync(join(directory, "objects", "info"), { recursive: true });
    mkdirSync(join(directory, "refs", "heads"), { recursive: true });
    writeFileSync(join(directory, "HEAD"), "this file explains HEAD\n");
    writeFileSync(join(directory, "objects", "info", "README"), "x\n");
    writeFileSync(join(directory, "refs", "heads", "README"), "x\n");
  }

  test("is a bare repository only when git takes it for one; otherwise it is searched like any other directory", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    lookalike(join(t.tree, "docs", "git-internals"));
    t.clone("docs/git-internals/example");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", join(t.tree, "store.git")]);

    const { repositories, bare, unsearchable } = await discoverRepositories(t.tree);

    expect(bare).toEqual([join(t.tree, "store.git")]);
    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["docs/git-internals/example", "store.git"]);
    expect(unsearchable).toEqual([]);
  });

  test("inside a checkout, it is not mistaken for the checkout's own repository", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    lookalike(join(t.tree, "repo", "docs", "git-internals"));

    const inspection = await inspectTree(t.tree, t.options);

    expect(inspection.repositories.map((repository) => repository.relative)).toEqual(["repo"]);
    expect(treeBlocker(inspection)).toBeNull();
  });

  test("a bare repository the repository around it tracks is that project's content; the one that tracks it answers for it", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const repo = t.linked("repo", "agent/a");
    const fixture = join(repo, "tests", "fixtures", "sample.git");
    // Test data like Gitea's and libgit2's: a bare repository with commits of its own and no remote.
    git(f.scratch, ["clone", "--bare", localRepositoryAt(join(f.scratch, "sample-source")), fixture]);
    git(fixture, ["remote", "remove", "origin"]);

    // Made by an agent in its checkout and not committed, it is a repository like any other.
    const made = byRelative(await inspectTree(t.tree, t.options));
    expect(made["repo/tests/fixtures/sample.git"]).toMatchObject({ bare: true, kind: "standalone", unsaved: true, blocker: { reason: "snapshot_failed" } });

    git(repo, ["add", "-f", "tests"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "add the fixture"]);
    const tracked = await inspectTree(t.tree, t.options);

    expect(tracked.repositories.map((repository) => repository.relative)).toEqual(["repo"]);
    expect(tracked.repositories[0]).toMatchObject({ kind: "shared-linked", bare: false, blocker: null });
    expect(treeBlocker(tracked)).toBeNull();
    // Entered like any directory: a clone an agent left inside it is still found.
    t.clone("repo/tests/fixtures/sample.git/hooks/clone");
    const inside = await discoverRepositories(t.tree);
    expect(inside.bare).toEqual([]);
    expect(inside.repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["repo", "repo/tests/fixtures/sample.git/hooks/clone"]);
  });

  test("a bare repository the nearest repository around it does not track is judged, whatever an outer one holds", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    const store = join(t.tree, "repo", "scratch", "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);

    const { bare } = await discoverRepositories(t.tree);

    expect(bare).toEqual([store]);
  });

  test("a working tree with a HEAD, objects/ and refs/ of its own is searched, not taken for a bare repository", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const project = t.clone("project");
    writeFileSync(join(project, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(project, "objects"));
    mkdirSync(join(project, "refs"));
    t.clone("project/vendor/lib");

    const { repositories, bare } = await discoverRepositories(t.tree);

    expect(bare).toEqual([]);
    expect(repositories.map((path) => path.slice(t.tree.length + 1))).toEqual(["project", "project/vendor/lib"]);
  });

  test("one git cannot answer for blocks the tree: it may be a repository", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const store = join(t.tree, "store.git");
    git(f.scratch, ["init", "--bare", "--initial-branch=main", store]);
    writeFileSync(join(store, "config"), "[core]\n\trepositoryformatversion = 99\n\tbare = true\n");

    const discovery = await discoverRepositories(t.tree);

    expect(discovery.bare).toEqual([]);
    expect(discovery.unsearchable).toEqual([{ path: store, message: expect.stringContaining("Expected git repo version") }]);
    expect(treeBlocker(await inspectTree(t.tree, t.options))).toEqual({
      reason: "git_check_failed",
      message: expect.stringContaining(`cannot search ${store} for repositories`),
    });
  });
});

describe("saving a tree", () => {
  test("saves each linked worktree with unsaved work under the place the caller names, and nothing else", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const repo = t.linked("repo", "agent/a");
    writeFileSync(join(repo, "wip.txt"), "wip\n");
    const experiment = t.linked("repo-experiment", "agent/b");
    const head = commit(experiment);
    t.linked("clean", "agent/c");
    t.clone("clone");
    const inspection = await inspectTree(t.tree, t.options);
    const fenced: string[] = [];

    const saved = await snapshotTree(inspection, {
      subjectRef: "iss_1",
      maxBytes: BIG,
      now: new Date("2026-10-14T00:00:00Z"),
      dirOf: (repository) => `env/${repository.relative}`,
      before: () => { fenced.push("saved"); },
    });

    expect(saved.map((entry) => [entry.dir, entry.branch, entry.ref])).toEqual([
      ["env/repo", "agent/a", "refs/remi/snapshots/iss_1/1"],
      ["env/repo-experiment", "agent/b", "refs/remi/snapshots/iss_1/2"],
    ]);
    expect(saved[1]).toMatchObject({ head, commit: head });
    expect(git(f.bare, ["show", `${saved[0]!.commit}:wip.txt`])).toBe("wip");
    expect(fenced).toEqual(["saved", "saved"]);
    expect(git(f.bare, ["for-each-ref", "--format=%(refname)", "refs/remi/snapshots"]).split("\n")).toEqual([
      "refs/remi/snapshots/iss_1/1", "refs/remi/snapshots/iss_1/2",
    ]);
  });

  test("a parent's snapshot leaves out the repositories nested in it", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const repo = t.linked("repo", "agent/a");
    writeFileSync(join(repo, "wip.txt"), "wip\n");
    t.clone("repo/lib");
    writeFileSync(join(repo, "lib", "inner.txt"), "inner\n");
    const nested = t.linked("repo/tools/helper", "agent/b");
    writeFileSync(join(nested, "helper.txt"), "helper\n");
    const inspection = await inspectTree(t.tree, { ...t.options, maxBytes: BIG });
    // The standalone clone would block a real reclaim; this only looks at what the snapshots hold.
    const saved = await snapshotTree(inspection, {
      subjectRef: "iss_1", maxBytes: BIG, now: new Date(), dirOf: (repository) => repository.relative,
    });

    const parent = saved.find((entry) => entry.dir === "repo")!;
    const helper = saved.find((entry) => entry.dir === "repo/tools/helper")!;
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", parent.commit]).split("\n").sort()).toEqual(["README.md", "wip.txt"]);
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", helper.commit]).split("\n").sort()).toEqual(["README.md", "helper.txt"]);
  });

  test("names every shared repository of the trees once, to prune after they are gone", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("a", "agent/a");
    t.linked("b", "agent/b");
    t.clone("clone");
    const first = await inspectTree(t.tree, t.options);
    const second = await inspectTree(join(t.tree, "a"), t.options);

    expect(sharedRepositories([first, second])).toEqual([f.bare]);
  });
});

describe("a tree with linked worktrees that is copied", () => {
  /** A clone and a worktree of it, in one tree: the repository is part of the tree. */
  function cloneWithWorktree(f: ReclaimFixture, tree: string) {
    mkdirSync(tree, { recursive: true });
    const clone = join(tree, "clone");
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), clone]);
    git(clone, ["worktree", "add", "-b", "feature", join(tree, "clone-wt"), "origin/main"]);
    writeFileSync(join(tree, "clone-wt", "wip.txt"), "wip\n");
    return clone;
  }

  // `git worktree repair` follows the `.git` file of the copy, which names the original repository: older git
  // repairs that one, cross-links the two, and leaves the copy broken as soon as the original is gone.
  test("a worktree of a repository copied with it names the copy, and works when the original is gone", async () => {
    const f = reclaimFixture();
    const source = join(f.scratch, "topic");
    cloneWithWorktree(f, source);
    const listed = await listLinkedWorktrees(source);
    const copy = join(f.scratch, "issue");
    cpSync(source, copy, { recursive: true });

    await repairCopiedWorktrees(listed, source, copy);
    rmSync(source, { recursive: true });
    await pruneWorktrees(join(copy, "clone", ".git"));

    expect(git(join(copy, "clone-wt"), ["status", "--porcelain=v1"])).toBe("?? wip.txt");
    expect(git(join(copy, "clone-wt"), ["rev-parse", "--git-dir"])).toBe(join(copy, "clone", ".git", "worktrees", "clone-wt"));
    expect(git(join(copy, "clone"), ["worktree", "list", "--porcelain"])).toContain(join(copy, "clone-wt"));
  });

  test("a worktree of a repository outside the tree is repaired in that repository", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    const listed = await listLinkedWorktrees(t.tree);
    const copy = join(f.scratch, "copy");
    cpSync(t.tree, copy, { recursive: true });

    await repairCopiedWorktrees(listed, t.tree, copy);
    rmSync(t.tree, { recursive: true });
    await pruneWorktrees(f.bare);

    expect(git(join(copy, "repo"), ["status", "--porcelain=v1"])).toBe("");
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain(join(copy, "repo"));
  });
});

describe("which worktrees of a copied tree are copies", () => {
  test("only a worktree that stands in the target as a copy of the original is repaired; the target's own is left alone", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    t.linked("other", "agent/b");
    const listed = await listLinkedWorktrees(t.tree);
    const target = join(f.scratch, "target");
    // `repo` is copied; `other` meets a worktree of the target's own at the same path, and `absent` is not there at all.
    cpSync(join(t.tree, "repo"), join(target, "repo"), { recursive: true });
    mkdirSync(target, { recursive: true });
    git(f.bare, ["worktree", "add", "-b", "own", join(target, "other"), "origin/main"]);
    const own = git(join(target, "other"), ["rev-parse", "--git-dir"]);

    await repairCopiedWorktrees([...listed, { path: "absent", owner: { path: f.bare, inside: false } }], t.tree, target);

    const registered = git(f.bare, ["worktree", "list", "--porcelain"]);
    expect(registered).toContain(join(target, "repo"));
    expect(registered).not.toContain(join(t.tree, "repo"));
    expect(registered).toContain(join(t.tree, "other"));
    expect(git(join(target, "other"), ["rev-parse", "--git-dir"])).toBe(own);
  });
});

describe("a tree with linked worktrees that moves", () => {
  test("repairing after the move keeps every worktree working through the prune that follows", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    const repo = t.linked("repo", "agent/a");
    writeFileSync(join(repo, "wip.txt"), "wip\n");
    const detached = join(t.tree, "detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    const detachedHead = commit(detached, "detached.txt");
    const unrepaired = t.linked("unrepaired", "agent/b");
    // A clone and a worktree of it move together: the repository is part of the tree.
    const clone = t.clone("clone");
    git(clone, ["worktree", "add", "-b", "feature", join(t.tree, "clone-wt"), "origin/main"]);
    const library = join(f.scratch, "library");
    git(f.scratch, ["init", "--initial-branch=main", library]);
    commit(library, "lib.txt");
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);
    mkdirSync(join(t.tree, "broken"));
    writeFileSync(join(t.tree, "broken", ".git"), "gitdir: /nonexistent/place\n");

    const listed = await listLinkedWorktrees(t.tree);

    // The submodule has a git directory of its own and the broken one cannot be read: neither has a record to renew.
    expect(listed).toEqual([
      { path: "clone-wt", owner: { path: "clone/.git", inside: true } },
      { path: "detached", owner: { path: f.bare, inside: false } },
      { path: "repo", owner: { path: f.bare, inside: false } },
      { path: "unrepaired", owner: { path: f.bare, inside: false } },
    ]);

    const moved = join(f.scratch, "moved");
    renameSync(t.tree, moved);
    await repairMovedWorktrees(listed.filter((worktree) => worktree.path !== "unrepaired"), moved);
    await pruneWorktrees(f.bare);

    // (A submodule's own link is relative and breaks with the move; a worktree repair cannot help with that.)
    expect(git(join(moved, "repo"), ["status", "--porcelain=v1", "--ignore-submodules=all"])).toContain("?? wip.txt");
    expect(git(join(moved, "detached"), ["rev-parse", "HEAD"])).toBe(detachedHead);
    expect(git(join(moved, "clone-wt"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
    expect(git(join(moved, "clone"), ["worktree", "list", "--porcelain"])).toContain(join(moved, "clone-wt"));
    const registered = git(f.bare, ["worktree", "list", "--porcelain"]);
    expect(registered).toContain(join(moved, "repo"));
    expect(registered).toContain(join(moved, "detached"));
    // What nobody repaired is what the prune dropped, and with it the worktree.
    expect(registered).not.toContain("unrepaired");
    expect(() => git(join(moved, "unrepaired"), ["status"])).toThrow();
  });

  test("a worktree that cannot be repaired is logged, not raised, and the others are still repaired", async () => {
    const f = reclaimFixture();
    const t = treeOf(f);
    t.linked("repo", "agent/a");
    const listed = await listLinkedWorktrees(t.tree);
    const moved = join(f.scratch, "moved");
    renameSync(t.tree, moved);

    await repairMovedWorktrees([
      { path: "not-there", owner: { path: join(f.scratch, "no-such-repository.git"), inside: false } },
      ...listed,
    ], moved);
    await pruneWorktrees(f.bare);

    expect(git(join(moved, "repo"), ["status", "--porcelain=v1"])).toBe("");
  });
});
