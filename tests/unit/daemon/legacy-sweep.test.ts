import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import { layoutMarkerFile, sharedRoot } from "@daemon/agent-runtime/workspace/layout.js";
import { countRetainedWorktrees, readRetainedList, writeRetainedList } from "@daemon/agent-runtime/workspace/legacy-retained.js";
import { runLegacySweep } from "@daemon/agent-runtime/workspace/legacy-sweep.js";
import { readSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-10-13T08:00:00.000Z");
const REPO_URL = "https://example.test/org/repo.git";

function git(cwd: string, args: string[]): string {
  // A host-level hook directory would slow every commit; these tests exercise git, not hooks.
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
  }).trim();
}

function commit(repository: string, file = "local.txt"): string {
  writeFileSync(join(repository, file), `${file}\n`);
  git(repository, ["add", file]);
  git(repository, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", `add ${file}`]);
  return git(repository, ["rev-parse", "HEAD"]);
}

interface OldLayout {
  root: string;
  bare: string;
  /** Adds a worktree of the shared repository at `<root>/<relative>`. */
  worktree(relative: string, branch: string, detached?: boolean): string;
  /** Adds a plain clone of the origin at `<root>/<relative>`: its `.git` is a directory. */
  clone(relative: string): string;
  marker(directory: string, payload: Record<string, unknown>): void;
}

/** A workspaces root as the pre-ADR-0018 daemon left it: shared caches in dot directories. */
function oldLayout(): OldLayout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-legacy-sweep-")));
  roots.push(root);
  const origin = join(root, "..", `origin-${Math.random().toString(36).slice(2)}.git`);
  const source = join(root, "..", `source-${Math.random().toString(36).slice(2)}`);
  roots.push(origin, source);
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--initial-branch=main", source]);
  writeFileSync(join(source, "README.md"), "initial\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["push", origin, "main"]);
  const bare = join(root, ".repos", "local", "repo-0123456789abcdef.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(root, ["clone", "--bare", origin, bare]);
  git(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(bare, ["fetch", "origin"]);
  git(bare, ["config", "multiremi.repository-url", REPO_URL]);
  return {
    root,
    bare,
    worktree(relative, branch, detached = false) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      if (detached) git(bare, ["worktree", "add", "--detach", path, "origin/main"]);
      else git(bare, ["worktree", "add", "-b", branch, path, "origin/main"]);
      return path;
    },
    clone(relative) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      git(root, ["clone", origin, path]);
      return path;
    },
    marker(directory, payload) {
      mkdirSync(join(directory, ".multiremi"), { recursive: true });
      writeFileSync(join(directory, ".multiremi", "gc.json"), JSON.stringify({ version: 1, workspace_id: "local", ...payload }));
    },
  };
}

const sharedBare = (root: string) => join(root, "shared", "repos", "local", "repo-0123456789abcdef.git");

describe("legacy layout sweep", () => {
  test("a root without any older layout only gets the marker", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-legacy-fresh-")));
    roots.push(root);
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "_topics", "om_1"), { recursive: true });

    const result = await runLegacySweep({ root, now: NOW });

    expect(result).toMatchObject({ swept: true, worktrees: 0, snapshots: 0, legacyDirectory: null, movedEntries: [] });
    expect(existsSync(layoutMarkerFile(root))).toBe(true);
    expect(readdirSync(root).sort()).toEqual(["_topics", "registry", "shared", "work"]);
    expect((await runLegacySweep({ root, now: NOW })).swept).toBe(false);
  });

  test("saves unsaved work of known subjects, records them as reclaimed and sets the old layout aside", async () => {
    const old = oldLayout();
    const dirty = old.worktree("issues/MUL-1/repo", "agent/MUL-1");
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1", task_id: "tsk_1" });
    writeFileSync(join(dirty, "README.md"), "edited\n");
    writeFileSync(join(dirty, "scratch.txt"), "untracked\n");
    mkdirSync(join(old.root, "issues", "MUL-1", ".multiremi"), { recursive: true });
    writeFileSync(join(old.root, "issues", "MUL-1", ".multiremi", "task.json"), JSON.stringify({ issue: { key: "MUL-1" } }));

    const unpushed = old.worktree("chats/chat_1/repo", "chat/chat_1");
    old.marker(join(old.root, "chats", "chat_1"), { kind: "chat", chat_session_id: "chat_1" });
    writeFileSync(join(unpushed, "local.txt"), "local\n");
    git(unpushed, ["add", "."]);
    git(unpushed, ["commit", "-m", "local"]);

    old.worktree("chats/chat_clean/repo", "chat/chat_clean");
    old.marker(join(old.root, "chats", "chat_clean"), { kind: "chat", chat_session_id: "chat_clean" });

    const orphanTask = old.worktree("tasks/tsk_9/repo", "agent/tsk_9");
    old.marker(join(old.root, "tasks", "tsk_9"), { kind: "quick_create", task_id: "tsk_9" });
    writeFileSync(join(orphanTask, "note.txt"), "task note\n");

    const discussion = old.worktree("discussions/MUL-1/ises_side/repo", "", true);
    old.marker(join(old.root, "discussions", "MUL-1", "ises_side"), { kind: "discussion_issue", issue_id: "iss_1" });
    writeFileSync(join(discussion, "README.md"), "discussion edit\n");

    mkdirSync(join(old.root, ".runtime", "ises_1", "agt_1", "1", "home"), { recursive: true });
    mkdirSync(join(old.root, ".snapshots", "local", "view"), { recursive: true });
    writeFileSync(join(old.root, ".snapshots", "local", "view", "file.txt"), "view\n");
    mkdirSync(join(old.root, "_topics", "om_1"), { recursive: true });
    mkdirSync(join(old.root, "work", "iss_new"), { recursive: true });
    const headBefore = git(dirty, ["rev-parse", "HEAD"]);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    // The discussion's edit is saved too, but under legacy/: a discussion has no subject to restore it into.
    expect(result).toMatchObject({ swept: true, worktrees: 5, snapshots: 4, recordedSubjects: 2 });
    const bare = sharedBare(old.root);
    expect(git(bare, ["for-each-ref", "--format=%(refname)", "refs/remi/snapshots"]).split("\n").sort()).toEqual([
      "refs/remi/snapshots/chat_1/1",
      "refs/remi/snapshots/iss_1/1",
      "refs/remi/snapshots/legacy/ises_side/1",
      "refs/remi/snapshots/legacy/tsk_9/1",
    ]);
    expect(git(bare, ["show", "refs/remi/snapshots/legacy/ises_side/1:README.md"])).toBe("discussion edit");
    expect(git(bare, ["show", "refs/remi/snapshots/iss_1/1:scratch.txt"])).toBe("untracked");
    expect(git(bare, ["show", "refs/remi/snapshots/iss_1/1:README.md"])).toBe("edited");
    expect(git(bare, ["rev-parse", "refs/remi/snapshots/chat_1/1"])).toBe(git(bare, ["rev-parse", "chat/chat_1"]));
    expect(git(bare, ["rev-parse", "refs/remi/snapshots/iss_1/1^"])).toBe(headBefore);

    const issue = readSubjectRecord(old.root, { kind: "issue", id: "iss_1" })!;
    expect(issue).toMatchObject({
      state: "reclaimed", workspace_id: "local", issue_key: "MUL-1", external_work_dir: null,
      reclaimed_at: NOW.toISOString(),
      repos: [{ repo_url: REPO_URL, dir: "repo", branch: "agent/MUL-1" }],
      snapshot: { created_at: NOW.toISOString(), wiki_files: 0, git: [{
        repo_url: REPO_URL, ref: "refs/remi/snapshots/iss_1/1", head: headBefore, branch: "agent/MUL-1",
      }] },
    });
    expect(readSubjectRecord(old.root, { kind: "chat", id: "chat_1" })?.snapshot?.git[0]?.ref).toBe("refs/remi/snapshots/chat_1/1");
    expect(readSubjectRecord(old.root, { kind: "chat", id: "chat_clean" })).toBeNull();
    expect(readSubjectRecord(old.root, { kind: "task", id: "tsk_9" })).toBeNull();

    expect(result.legacyDirectory).toBe(join(old.root, "legacy-20261013"));
    expect(result.movedEntries.sort()).toEqual([".runtime", "chats", "discussions", "issues", "tasks"]);
    expect(readdirSync(join(old.root, "legacy-20261013")).sort()).toEqual([".runtime", "chats", "discussions", "issues", "tasks"]);
    expect(readFileSync(join(old.root, "legacy-20261013", "issues", "MUL-1", "repo", "scratch.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(old.root, "shared", "code-views", "local", "view", "file.txt"), "utf8")).toBe("view\n");
    expect(existsSync(join(old.root, ".repos"))).toBe(false);
    expect(existsSync(join(old.root, ".snapshots"))).toBe(false);
    expect(existsSync(join(old.root, "_topics", "om_1"))).toBe(true);
    expect(existsSync(join(old.root, "work", "iss_new"))).toBe(true);
    // The moved worktrees no longer exist at their registered paths, so the shared repository forgot them.
    expect(git(bare, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toEqual([`worktree ${bare}`]);
    expect(existsSync(layoutMarkerFile(old.root))).toBe(true);
    // Running unsaved work was only read: the old worktrees keep their files.
    expect(readFileSync(join(old.root, "legacy-20261013", "issues", "MUL-1", "repo", "README.md"), "utf8")).toBe("edited\n");

    expect((await runLegacySweep({ root: old.root, now: NOW })).swept).toBe(false);
  });

  test("a worktree whose unsaved work cannot be snapshotted moves to retained/ and is listed", async () => {
    const old = oldLayout();
    const big = old.worktree("issues/MUL-2/repo", "agent/MUL-2");
    old.marker(join(old.root, "issues", "MUL-2"), { kind: "issue", issue_id: "iss_2" });
    writeFileSync(join(big, "big.bin"), "x".repeat(5000));
    const broken = join(old.root, "chats", "chat_broken", "repo");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/place/worktrees/x\n");
    writeFileSync(join(broken, "work.txt"), "work\n");

    const result = await runLegacySweep({ root: old.root, now: NOW, snapshotMaxBytes: 4096 });

    const legacy = join(old.root, "legacy-20261013");
    expect(result).toMatchObject({ swept: true, worktrees: 2, snapshots: 0, retained: 2, recordedSubjects: 0, legacyDirectory: legacy });
    expect(git(sharedBare(old.root), ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    // Moved ahead of the rest of its entry, to the same relative path below retained/.
    expect(readFileSync(join(legacy, "retained", "issues", "MUL-2", "repo", "big.bin"), "utf8")).toHaveLength(5000);
    expect(readFileSync(join(legacy, "retained", "chats", "chat_broken", "repo", "work.txt"), "utf8")).toBe("work\n");
    expect(existsSync(join(legacy, "issues", "MUL-2", "repo"))).toBe(false);
    expect(existsSync(join(legacy, "issues", "MUL-2", ".multiremi", "gc.json"))).toBe(true);
    expect(readRetainedList(legacy)).toEqual({
      version: 1,
      worktrees: [
        { path: "retained/chats/chat_broken/repo", original_path: "chats/chat_broken/repo", reason: "git_check_failed", message: expect.stringContaining("cannot inspect") },
        { path: "retained/issues/MUL-2/repo", original_path: "issues/MUL-2/repo", reason: "snapshot_failed", message: expect.stringContaining("snapshot limit") },
      ],
    });
    expect(countRetainedWorktrees(legacy)).toBe(2);
    expect(existsSync(layoutMarkerFile(old.root))).toBe(true);
  });

  test("a retained worktree keeps working: its repository follows it and the cache move", async () => {
    const old = oldLayout();
    const big = old.worktree("issues/MUL-2/repo", "agent/MUL-2");
    writeFileSync(join(big, "big.bin"), "x".repeat(5000));

    await runLegacySweep({ root: old.root, now: NOW, snapshotMaxBytes: 4096 });

    const retained = join(old.root, "legacy-20261013", "retained", "issues", "MUL-2", "repo");
    expect(git(retained, ["status", "--porcelain=v1"])).toBe("?? big.bin");
    expect(git(retained, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("agent/MUL-2");
    expect(readFileSync(join(retained, ".git"), "utf8")).toContain(join(old.root, "shared", "repos"));
    expect(git(sharedBare(old.root), ["worktree", "list", "--porcelain"])).toContain(retained);
  });

  test("when the new cache already has the repository, the old one is retained with the worktrees that need it", async () => {
    const old = oldLayout();
    // A fresh clone made before the sweep ran: the old repository cannot be merged into it.
    const fresh = sharedBare(old.root);
    mkdirSync(dirname(fresh), { recursive: true });
    git(old.root, ["clone", "--bare", old.bare, fresh]);
    const dirty = old.worktree("issues/MUL-2/repo", "agent/MUL-2");
    const unpushed = commit(dirty, "unpushed.txt");
    writeFileSync(join(dirty, "big.bin"), Buffer.alloc(5000, 1));
    const snapshotted = old.worktree("issues/MUL-3/repo", "agent/MUL-3");
    writeFileSync(join(snapshotted, "small.txt"), "small\n");
    old.marker(join(old.root, "issues", "MUL-3"), { kind: "issue", issue_id: "iss_3" });

    const result = await runLegacySweep({ root: old.root, now: NOW, snapshotMaxBytes: 1024 });

    expect(result).toMatchObject({ retained: 1, snapshots: 1, recordedSubjects: 1 });
    const legacy = join(old.root, "legacy-20261013");
    const retained = join(legacy, "retained", "issues", "MUL-2", "repo");
    const keptRepository = join(legacy, "retained", ".repos", "local", "repo-0123456789abcdef.git");
    // The retained worktree still has its commits, and its repository is retained next to it.
    expect(git(retained, ["rev-parse", "HEAD"])).toBe(unpushed);
    expect(git(retained, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("agent/MUL-2");
    expect(readFileSync(join(retained, ".git"), "utf8")).toContain(keptRepository);
    expect(git(keptRepository, ["worktree", "list", "--porcelain"])).toContain(retained);
    // What expiry deletes: the leftover `.repos` no longer holds the repository.
    expect(existsSync(join(old.root, ".repos"))).toBe(false);
    expect(existsSync(join(legacy, ".repos", "local", "repo-0123456789abcdef.git"))).toBe(false);
    // The new cache is not touched, except that the snapshot refs made in the old one came over: the record points there.
    expect(git(fresh, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/main");
    const [entry] = readSubjectRecord(old.root, { kind: "issue", id: "iss_3" })!.snapshot!.git;
    expect(git(fresh, ["rev-parse", entry!.ref])).toBe(entry!.commit);
    // Only the worktree is listed and counted; the repository is not one to delete on its own.
    expect(countRetainedWorktrees(legacy)).toBe(1);
  });

  test("a rerun after an interrupted sweep keeps the worktrees it retained earlier", async () => {
    const old = oldLayout();
    const legacy = join(old.root, "legacy-20261013");
    mkdirSync(join(legacy, "retained", "chats", "chat_1", "repo"), { recursive: true });
    writeFileSync(join(legacy, "retained", "chats", "chat_1", "repo", "work.txt"), "first run");
    writeRetainedList(legacy, {
      version: 1,
      worktrees: [{ path: "retained/chats/chat_1/repo", original_path: "chats/chat_1/repo", reason: "snapshot_failed", message: "first run" }],
    });
    const big = old.worktree("issues/MUL-2/repo", "agent/MUL-2");
    writeFileSync(join(big, "big.bin"), "x".repeat(5000));

    const result = await runLegacySweep({ root: old.root, now: NOW, snapshotMaxBytes: 4096 });

    expect(result.retained).toBe(1);
    expect(readRetainedList(legacy)!.worktrees.map((entry) => entry.path)).toEqual([
      "retained/chats/chat_1/repo",
      "retained/issues/MUL-2/repo",
    ]);
    expect(countRetainedWorktrees(legacy)).toBe(2);
  });

  test("an unreadable list from an earlier run is set aside instead of holding the sweep back", async () => {
    const old = oldLayout();
    const legacy = join(old.root, "legacy-20261013");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "retained.json"), "{ half a list");
    const big = old.worktree("issues/MUL-2/repo", "agent/MUL-2");
    writeFileSync(join(big, "big.bin"), "x".repeat(5000));

    const result = await runLegacySweep({ root: old.root, now: NOW, snapshotMaxBytes: 4096 });

    expect(result.retained).toBe(1);
    expect(readFileSync(join(legacy, "retained.json.unreadable"), "utf8")).toBe("{ half a list");
    expect(readRetainedList(legacy)!.worktrees.map((entry) => entry.path)).toEqual(["retained/issues/MUL-2/repo"]);
  });

  test("a worktree that was snapshotted is not retained: its work is in the ref", async () => {
    const old = oldLayout();
    const dirty = old.worktree("issues/MUL-1/repo", "agent/MUL-1");
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1" });
    writeFileSync(join(dirty, "scratch.txt"), "untracked\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ snapshots: 1, retained: 0 });
    expect(existsSync(join(old.root, "legacy-20261013", "retained"))).toBe(false);
    expect(existsSync(join(old.root, "legacy-20261013", "retained.json"))).toBe(false);
  });

  test("never follows a linked directory when looking for worktrees", async () => {
    const old = oldLayout();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-legacy-outside-")));
    roots.push(outside);
    mkdirSync(join(outside, "repo"));
    writeFileSync(join(outside, "repo", ".git"), "gitdir: /nonexistent\n");
    mkdirSync(join(old.root, "issues"));
    symlinkSync(outside, join(old.root, "issues", "linked"), "dir");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result.worktrees).toBe(0);
    expect(existsSync(join(outside, "repo", ".git"))).toBe(true);
  });

  test("losing the root aborts before anything is moved or marked", async () => {
    const old = oldLayout();
    mkdirSync(join(old.root, "issues", "MUL-3"), { recursive: true });
    let calls = 0;

    await expect(runLegacySweep({
      root: old.root,
      now: NOW,
      assertRootOwner: () => { if (++calls > 1) throw new Error("workspace root identity changed"); },
    })).rejects.toThrow("workspace root identity changed");

    expect(existsSync(join(old.root, "issues", "MUL-3"))).toBe(true);
    expect(existsSync(join(old.root, ".repos"))).toBe(true);
    expect(existsSync(layoutMarkerFile(old.root))).toBe(false);
  });

  test("a rerun after an interrupted sweep keeps earlier legacy entries and finishes", async () => {
    const old = oldLayout();
    mkdirSync(join(old.root, "legacy-20261013", "issues"), { recursive: true });
    writeFileSync(join(old.root, "legacy-20261013", "issues", "first.txt"), "from the first run\n");
    mkdirSync(join(old.root, "issues"));
    writeFileSync(join(old.root, "issues", "second.txt"), "from the second run\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result.movedEntries).toEqual(["issues"]);
    expect(readFileSync(join(old.root, "legacy-20261013", "issues", "first.txt"), "utf8")).toBe("from the first run\n");
    expect(readFileSync(join(old.root, "legacy-20261013", "issues.1", "second.txt"), "utf8")).toBe("from the second run\n");
  });
});

describe("legacy layout sweep of worktrees that stay or hide", () => {
  test("a Feishu topic worktree keeps working after the repository cache moved", async () => {
    const old = oldLayout();
    const topic = old.worktree("_topics/om_1/repo", "topic/om_1");
    writeFileSync(join(topic, "README.md"), "topic edit\n");
    expect(readFileSync(join(topic, ".git"), "utf8")).toContain(join(old.root, ".repos"));

    await runLegacySweep({ root: old.root, now: NOW });

    expect(readFileSync(join(topic, ".git"), "utf8")).toContain(join(old.root, "shared", "repos"));
    expect(git(topic, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("topic/om_1");
    expect(git(topic, ["status", "--porcelain=v1"])).toBe("M README.md");
    expect(git(sharedBare(old.root), ["worktree", "list", "--porcelain"])).toContain(topic);
  });

  test("repairs worktrees of a repository cache configured elsewhere", async () => {
    const old = oldLayout();
    const custom = join(old.root, "..", `custom-cache-${Math.random().toString(36).slice(2)}`);
    roots.push(custom);
    mkdirSync(join(custom, "local"), { recursive: true });
    const moved = join(custom, "local", "repo-0123456789abcdef.git");
    renameSync(old.bare, moved);
    const topic = join(old.root, "_topics", "om_2", "repo");
    mkdirSync(dirname(topic), { recursive: true });
    git(moved, ["worktree", "add", "-b", "topic/om_2", topic, "origin/main"]);
    const stray = join(old.root, "issues", "MUL-2", "repo");
    mkdirSync(dirname(stray), { recursive: true });
    git(moved, ["worktree", "add", "-b", "agent/MUL-2", stray, "origin/main"]);

    await runLegacySweep({ root: old.root, repoCacheRoot: custom, now: NOW });

    const listed = git(moved, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(topic);
    expect(listed).not.toContain(stray);
  });

  test("leaves a repository cache configured below the root in place", async () => {
    const old = oldLayout();
    const custom = join(old.root, "cache");
    mkdirSync(join(custom, "local"), { recursive: true });
    const moved = join(custom, "local", "repo-0123456789abcdef.git");
    renameSync(old.bare, moved);

    const result = await runLegacySweep({ root: old.root, repoCacheRoot: custom, now: NOW });

    expect(existsSync(moved)).toBe(true);
    expect(result.movedEntries).not.toContain("cache");
  });

  test("never sets the repository cache aside when the new cache already exists", async () => {
    const old = oldLayout();
    const dirty = old.worktree("issues/MUL-1/repo", "agent/MUL-1");
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1" });
    writeFileSync(join(dirty, "README.md"), "edited\n");
    // A fresh clone already sits where the new layout keeps the cache, plus an unrelated repository.
    const fresh = sharedBare(old.root);
    mkdirSync(dirname(fresh), { recursive: true });
    git(old.root, ["clone", "--bare", old.bare, fresh]);
    const other = join(old.bare, "..", "other-0123456789abcdef.git");
    git(old.root, ["clone", "--bare", old.bare, other]);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    // The snapshot the reclaimed record points at is reachable in the cache that is in use.
    const record = readSubjectRecord(old.root, { kind: "issue", id: "iss_1" })!;
    const ref = record.snapshot!.git[0]!.ref;
    expect(git(fresh, ["show", `${ref}:README.md`])).toBe("edited");
    // Repositories only the old cache had move over; the conflicting copy goes to the legacy directory.
    expect(existsSync(join(old.root, "shared", "repos", "local", "other-0123456789abcdef.git"))).toBe(true);
    expect(result.movedEntries).toContain(".repos");
    expect(existsSync(join(result.legacyDirectory!, ".repos", "local", "repo-0123456789abcdef.git"))).toBe(true);
  });

  test("finds unsaved work in the private execution directories of the old layout", async () => {
    const old = oldLayout();
    const generation = ".runtime/ises_1/agt_1/delegations/dlg_1/2/executions/abc";
    const checkout = old.worktree(`${generation}/work/repo`, "agent/on-demand");
    writeFileSync(join(checkout, "README.md"), "on demand edit\n");
    mkdirSync(join(old.root, generation, "home", "plugins", "cache", "pkg"), { recursive: true });

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 1, snapshots: 1 });
    const ref = git(sharedBare(old.root), ["for-each-ref", "--format=%(refname)", "refs/remi/snapshots"]);
    expect(ref).toBe("refs/remi/snapshots/legacy/runtime-ises_1/1");
    expect(git(sharedBare(old.root), ["show", `${ref}:README.md`])).toBe("on demand edit");
  });
});

describe("legacy layout sweep of repositories that are not linked worktrees", () => {
  const retainedList = (legacy: string) => readRetainedList(legacy)!.worktrees.map((entry) => [entry.original_path, entry.reason]);

  test("a standalone clone with unsaved work moves to retained/ and is listed: no snapshot could hold it", async () => {
    const old = oldLayout();
    old.marker(join(old.root, "chats", "chat_1"), { kind: "chat", chat_session_id: "chat_1" });
    const clone = old.clone("chats/chat_1/notes-repo");
    const local = commit(clone);
    writeFileSync(join(clone, "dirty.txt"), "uncommitted\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    const legacy = join(old.root, "legacy-20261013");
    expect(result).toMatchObject({ swept: true, worktrees: 1, snapshots: 0, retained: 1, recordedSubjects: 0, legacyDirectory: legacy });
    const retained = join(legacy, "retained", "chats", "chat_1", "notes-repo");
    expect(git(retained, ["rev-parse", "HEAD"])).toBe(local);
    expect(readFileSync(join(retained, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    expect(existsSync(join(legacy, "chats", "chat_1", "notes-repo"))).toBe(false);
    expect(readRetainedList(legacy)!.worktrees).toEqual([{
      path: "retained/chats/chat_1/notes-repo",
      original_path: "chats/chat_1/notes-repo",
      reason: "snapshot_failed",
      message: expect.stringContaining("standalone clone with unsaved work"),
    }]);
    expect(countRetainedWorktrees(legacy)).toBe(1);
    expect(git(sharedBare(old.root), ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(readSubjectRecord(old.root, { kind: "chat", id: "chat_1" })).toBeNull();
  });

  test("a clone with a commit on a side branch, a stash or no remote at all is retained too", async () => {
    const old = oldLayout();
    const sideBranch = old.clone("chats/chat_side/repo");
    git(sideBranch, ["checkout", "-b", "side"]);
    commit(sideBranch);
    git(sideBranch, ["checkout", "main"]);
    const stashed = old.clone("chats/chat_stash/repo");
    writeFileSync(join(stashed, "README.md"), "stashed\n");
    git(stashed, ["stash"]);
    const local = join(old.root, "chats", "chat_local", "repo");
    mkdirSync(local, { recursive: true });
    git(local, ["init", "--initial-branch=main"]);
    commit(local);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result.retained).toBe(3);
    expect(retainedList(join(old.root, "legacy-20261013"))).toEqual([
      ["chats/chat_local/repo", "snapshot_failed"],
      ["chats/chat_side/repo", "snapshot_failed"],
      ["chats/chat_stash/repo", "snapshot_failed"],
    ]);
  });

  test("a clean standalone clone is set aside with the rest of the old layout, not retained", async () => {
    const old = oldLayout();
    old.clone("chats/chat_1/reference");
    old.worktree("chats/chat_1/repo", "chat/chat_1");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, snapshots: 0, retained: 0 });
    expect(existsSync(join(old.root, "legacy-20261013", "chats", "chat_1", "reference", ".git"))).toBe(true);
    expect(existsSync(join(old.root, "legacy-20261013", "retained"))).toBe(false);
  });

  test("a worktree of a clone inside the old layout is retained, and no ref is written into the clone", async () => {
    const old = oldLayout();
    const clone = old.clone("chats/chat_1/clone");
    const worktree = join(old.root, "chats", "chat_1", "clone-wt");
    git(clone, ["worktree", "add", "-b", "feature", worktree, "origin/main"]);
    writeFileSync(join(worktree, "precious.txt"), "unsaved\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, snapshots: 0, retained: 1 });
    const legacy = join(old.root, "legacy-20261013");
    expect(retainedList(legacy)).toEqual([["chats/chat_1/clone-wt", "snapshot_failed"]]);
    expect(readFileSync(join(legacy, "retained", "chats", "chat_1", "clone-wt", "precious.txt"), "utf8")).toBe("unsaved\n");
    expect(git(join(legacy, "chats", "chat_1", "clone"), ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(git(sharedBare(old.root), ["for-each-ref", "refs/remi/snapshots"])).toBe("");
  });

  test("a clone inside a linked worktree is retained on its own; the worktree's work is saved without it", async () => {
    const old = oldLayout();
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1" });
    const repo = old.worktree("issues/MUL-1/repo", "agent/MUL-1");
    writeFileSync(join(repo, "wip.txt"), "wip\n");
    const nested = old.clone("issues/MUL-1/repo/third_party/lib");
    commit(nested);
    writeFileSync(join(nested, "inner.txt"), "inner\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, snapshots: 1, retained: 1, recordedSubjects: 1 });
    const legacy = join(old.root, "legacy-20261013");
    expect(retainedList(legacy)).toEqual([["issues/MUL-1/repo/third_party/lib", "snapshot_failed"]]);
    expect(readFileSync(join(legacy, "retained", "issues", "MUL-1", "repo", "third_party", "lib", "inner.txt"), "utf8")).toBe("inner\n");
    const [entry] = readSubjectRecord(old.root, { kind: "issue", id: "iss_1" })!.snapshot!.git;
    expect(entry).toMatchObject({ dir: "repo", branch: "agent/MUL-1" });
    expect(git(sharedBare(old.root), ["ls-tree", "-r", "--name-only", entry!.commit]).split("\n").sort()).toEqual(["README.md", "wip.txt"]);
  });

  test("what lies inside a retained repository moves along and is not listed on its own", async () => {
    const old = oldLayout();
    const outer = old.clone("chats/chat_1/outer");
    commit(outer);
    commit(old.clone("chats/chat_1/outer/inner"));

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result.retained).toBe(1);
    const legacy = join(old.root, "legacy-20261013");
    expect(retainedList(legacy)).toEqual([["chats/chat_1/outer", "snapshot_failed"]]);
    expect(existsSync(join(legacy, "retained", "chats", "chat_1", "outer", "inner", "local.txt"))).toBe(true);
    expect(countRetainedWorktrees(legacy)).toBe(1);
  });

  test("a bare repository with commits nobody else has is retained: it has no .git and is no worktree", async () => {
    const old = oldLayout();
    const store = join(old.root, "chats", "chat_1", "backup.git");
    mkdirSync(dirname(store), { recursive: true });
    git(old.root, ["init", "--bare", "--initial-branch=main", store]);
    const source = old.clone("chats/chat_1/source");
    // The commit lives in the bare repository alone: the clone that made it went back to the origin's state.
    const only = commit(source, "backup-only.txt");
    git(source, ["push", store, "HEAD:refs/heads/main"]);
    git(source, ["reset", "--hard", "origin/main"]);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, retained: 1 });
    const legacy = join(old.root, "legacy-20261013");
    expect(retainedList(legacy)).toEqual([["chats/chat_1/backup.git", "snapshot_failed"]]);
    expect(readRetainedList(legacy)!.worktrees[0]!.message).toContain("standalone bare repository with unsaved work");
    expect(git(join(legacy, "retained", "chats", "chat_1", "backup.git"), ["rev-parse", "main"])).toBe(only);
  });

  test("an empty bare repository and a mirror of the origin are set aside with the rest, not retained", async () => {
    const old = oldLayout();
    const chat = join(old.root, "chats", "chat_1");
    mkdirSync(chat, { recursive: true });
    git(chat, ["init", "--bare", "--initial-branch=main", join(chat, "empty.git")]);
    const mirror = join(chat, "mirror.git");
    git(old.root, ["clone", "--bare", old.bare, mirror]);
    git(mirror, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(mirror, ["fetch", "origin"]);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, snapshots: 0, retained: 0 });
    expect(existsSync(join(old.root, "legacy-20261013", "chats", "chat_1", "empty.git", "HEAD"))).toBe(true);
    expect(existsSync(join(old.root, "legacy-20261013", "retained"))).toBe(false);
  });

  test("a clone whose remote is a repository of another old entry has no remote that outlives the sweep's trees", async () => {
    const old = oldLayout();
    const store = join(old.root, "issues", "MUL-1", "store.git");
    mkdirSync(dirname(store), { recursive: true });
    git(old.root, ["init", "--bare", "--initial-branch=main", store]);
    const project = join(old.root, "chats", "chat_1", "project");
    mkdirSync(dirname(project), { recursive: true });
    git(old.root, ["clone", store, project]);
    git(project, ["checkout", "-b", "main"]);
    commit(project);
    git(project, ["push", "origin", "main"]);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, retained: 2 });
    expect(retainedList(join(old.root, "legacy-20261013"))).toEqual([
      ["chats/chat_1/project", "snapshot_failed"],
      ["issues/MUL-1/store.git", "snapshot_failed"],
    ]);
  });

  test("a linked worktree of the cache inside a retained repository keeps working at its new place", async () => {
    const old = oldLayout();
    const outer = old.clone("chats/chat_1/outer");
    commit(outer);
    const nested = join(outer, "nested-wt");
    git(old.bare, ["worktree", "add", "-b", "nested", nested, "origin/main"]);
    writeFileSync(join(nested, "wip.txt"), "wip\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    // The worktree's own unsaved work is saved as a ref as well; the files go with the clone it stands in.
    expect(result).toMatchObject({ worktrees: 2, snapshots: 1, retained: 1 });
    const moved = join(old.root, "legacy-20261013", "retained", "chats", "chat_1", "outer", "nested-wt");
    expect(git(moved, ["status", "--porcelain=v1"])).toBe("?? wip.txt");
    expect(git(moved, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("nested");
    expect(git(sharedBare(old.root), ["worktree", "list", "--porcelain"])).toContain(moved);
  });

  test("records where each saved worktree stood, by its place below the old workspace", async () => {
    const old = oldLayout();
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1" });
    writeFileSync(join(old.worktree("issues/MUL-1/repo", "agent/MUL-1"), "a.txt"), "a\n");
    writeFileSync(join(old.worktree("issues/MUL-1/repo-experiment", "experiment"), "b.txt"), "b\n");
    writeFileSync(join(old.worktree("issues/MUL-1/repo/tools/helper", "helper"), "c.txt"), "c\n");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ snapshots: 3, retained: 0 });
    const record = readSubjectRecord(old.root, { kind: "issue", id: "iss_1" })!;
    expect(record.snapshot!.git.map((entry) => [entry.dir, entry.branch])).toEqual([
      ["repo", "agent/MUL-1"], ["repo/tools/helper", "helper"], ["repo-experiment", "experiment"],
    ]);
    expect(record.repos.map((repo) => repo.dir)).toEqual(["repo", "repo/tools/helper", "repo-experiment"]);
  });

  test("a read-only discussion work set is rebuilt from the Issue branch, but a clone an agent put there is retained", async () => {
    const old = oldLayout();
    old.marker(join(old.root, "discussions", "MUL-1", "ises_side"), { kind: "discussion_issue", issue_id: "iss_1" });
    old.worktree("discussions/MUL-1/ises_side/repo", "", true);
    commit(old.clone("discussions/MUL-1/ises_side/notes"));

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 2, snapshots: 0, retained: 1 });
    expect(retainedList(join(old.root, "legacy-20261013"))).toEqual([["discussions/MUL-1/ises_side/notes", "snapshot_failed"]]);
  });

  test("a clone in the private execution directories of the old layout is found too", async () => {
    const old = oldLayout();
    const generation = ".runtime/ises_1/agt_1/2/executions/abc";
    commit(old.clone(`${generation}/work/scratch`));
    mkdirSync(join(old.root, generation, "home", "plugins", "marketplace", ".git"), { recursive: true });

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 1, retained: 1 });
    expect(retainedList(join(old.root, "legacy-20261013"))).toEqual([[`${generation}/work/scratch`, "snapshot_failed"]]);
  });

  test.each([
    ["a repository the agent called home", ".runtime/ises_1/agt_1/1/work/home", null],
    ["a repository below a directory called task-tmp", ".runtime/ises_1/agt_1/1/work/project/task-tmp/lib", null],
    ["a repository below a directory called .remi-runtime", ".runtime/ises_1/agt_1/1/work/.remi-runtime/lib", null],
    ["a repository in a directory called home that is no generation's", ".runtime/ises_1/home/lib", null],
    ["a repository in a home directory beside a work directory that is no generation's", ".runtime/ises_1/agt_1/home/lib", ".runtime/ises_1/agt_1/work"],
    ["a repository in a home directory beside a work directory in a project", ".runtime/ises_1/agt_1/1/work/project/home/lib", ".runtime/ises_1/agt_1/1/work/project/work"],
  ])("%s of the old layout is found, not skipped", async (_name, relative, sibling) => {
    const old = oldLayout();
    if (sibling) mkdirSync(join(old.root, sibling), { recursive: true });
    commit(old.clone(relative));

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 1, retained: 1 });
  });

  test.each([
    ["a generation", ".runtime/ises_1/agt_1/2"],
    ["a delegation's generation", ".runtime/ises_1/agt_1/delegations/dlg_9/2"],
    ["an execution's directory in a generation", ".runtime/ises_1/agt_1/2/executions/abc123"],
    ["an execution's directory in a delegation's generation", ".runtime/ises_1/agt_1/delegations/dlg_9/2/executions/abc123"],
  ])("provider state of %s is not walked, its work directory is", async (_name, generation) => {
    const old = oldLayout();
    for (const support of ["home", "task-tmp", ".remi-runtime"]) commit(old.clone(`${generation}/${support}/state/clone`));
    commit(old.clone(`${generation}/work/clone`));

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 1, retained: 1 });
    expect(retainedList(join(old.root, "legacy-20261013"))).toEqual([[`${generation}/work/clone`, "snapshot_failed"]]);
  });

  test("a Chat's generation has no work directory, and its provider home is state all the same", async () => {
    const old = oldLayout();
    commit(old.clone(".runtime/chat_1/agt_1/1/home/plugins/marketplace/clone"));
    commit(old.clone(".runtime/chat_1/agt_1/1/task-tmp/tsk_1-abc123/clone"));

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 0, retained: 0 });
  });

  test("the unsaved work of a discussion's own worktree is saved under legacy/, and no Issue's record carries it", async () => {
    const old = oldLayout();
    old.marker(join(old.root, "issues", "MUL-1"), { kind: "issue", issue_id: "iss_1" });
    old.worktree("issues/MUL-1/repo", "agent/MUL-1");
    old.marker(join(old.root, "discussions", "MUL-1", "ises_side"), { kind: "discussion_issue", issue_id: "iss_1", issue_session_id: "ises_side" });
    const scratch = old.worktree("discussions/MUL-1/ises_side/scratch", "try");
    writeFileSync(join(scratch, "analysis.md"), "uncommitted analysis\n");
    const idea = old.worktree("discussions/MUL-1/ises_side/idea", "", true);
    const ahead = commit(idea, "idea.txt");

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ worktrees: 3, snapshots: 2, retained: 0, recordedSubjects: 0 });
    const bare = sharedBare(old.root);
    const refs = git(bare, ["for-each-ref", "--format=%(refname)", "refs/remi/snapshots"]).split("\n");
    expect(refs).toHaveLength(2);
    for (const ref of refs) expect(ref).toMatch(/^refs\/remi\/snapshots\/legacy\/ises_side\/[12]$/);
    // The numbering follows whichever worktree was saved first.
    const commits = refs.map((ref) => git(bare, ["rev-parse", ref]));
    expect(commits).toContain(ahead);
    const dirty = commits.find((id) => id !== ahead)!;
    expect(git(bare, ["show", `${dirty}:analysis.md`])).toBe("uncommitted analysis");
    // The Issue has nothing unsaved of its own, and a discussion's work is never restored into its checkout.
    expect(readSubjectRecord(old.root, { kind: "issue", id: "iss_1" })).toBeNull();
  });

  // Root reads and moves any directory, so there is nothing to refuse there.
  test.skipIf(process.getuid?.() === 0)("a directory that cannot be listed is retained instead of holding the sweep back", async () => {
    const old = oldLayout();
    const locked = join(old.root, "issues", "MUL-1", "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "maybe-a-repository"), "x");
    chmodSync(locked, 0o000);

    const result = await runLegacySweep({ root: old.root, now: NOW });

    expect(result).toMatchObject({ swept: true, retained: 1 });
    const legacy = join(old.root, "legacy-20261013");
    expect(readRetainedList(legacy)!.worktrees).toEqual([{
      path: "retained/issues/MUL-1/locked",
      original_path: "issues/MUL-1/locked",
      reason: "git_check_failed",
      message: expect.stringContaining("cannot search"),
    }]);
    // The agent's lock was lifted to move it, and the work inside is where an operator can read it.
    expect(readFileSync(join(legacy, "retained", "issues", "MUL-1", "locked", "maybe-a-repository"), "utf8")).toBe("x");
    expect(existsSync(layoutMarkerFile(old.root))).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)("a directory that can neither be listed nor moved stays in the legacy directory, and the sweep finishes", async () => {
    const old = oldLayout();
    const parent = join(old.root, "issues", "MUL-1");
    const locked = join(parent, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    // Not even this user can take it out of its parent.
    chmodSync(parent, 0o555);
    try {
      const result = await runLegacySweep({ root: old.root, now: NOW });

      expect(result).toMatchObject({ swept: true, retained: 0 });
      // Nothing was retained, so nothing is left behind that expiry would have to spare.
      expect(existsSync(join(old.root, "legacy-20261013", "retained"))).toBe(false);
      expect(existsSync(join(old.root, "legacy-20261013", "retained.json"))).toBe(false);
      expect(existsSync(join(old.root, "legacy-20261013", "issues", "MUL-1", "locked"))).toBe(true);
      expect(existsSync(layoutMarkerFile(old.root))).toBe(true);
    } finally {
      chmodSync(join(old.root, "legacy-20261013", "issues", "MUL-1"), 0o755);
      chmodSync(join(old.root, "legacy-20261013", "issues", "MUL-1", "locked"), 0o755);
    }
  });
});

describe("the daemon's startup sweep", () => {
  /** The daemon surface `sweepLegacyLayout` touches, with a root the sweep cannot finish in. */
  function sweepingDaemon(options: { once?: boolean } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-daemon-sweep-")));
    roots.push(root);
    mkdirSync(join(root, "issues", "MUL-1"), { recursive: true });
    // A file where the shared directory belongs makes every attempt fail.
    writeFileSync(sharedRoot(root), "in the way");
    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      options: { workspacesRoot: root, repoCacheRoot: join(root, "shared", "repos"), once: options.once ?? false },
      issueWorkspaceLifecycleLocks: new IssueWorkspaceLifecycleLocker(),
      stopped: false,
      pollAbort: new AbortController(),
      assertWorkspaceRootOwner: () => {},
    });
    return { root, daemon: daemon as { sweepLegacyLayout(): Promise<void>; stopped: boolean; pollAbort: AbortController } };
  }

  test("a failed sweep holds the daemon back and is retried until it succeeds", async () => {
    const { root, daemon } = sweepingDaemon();
    let finished = false;
    const sweeping = daemon.sweepLegacyLayout().then(() => { finished = true; });

    await Bun.sleep(300);
    expect(finished).toBe(false);
    expect(existsSync(layoutMarkerFile(root))).toBe(false);
    rmSync(sharedRoot(root));
    await sweeping;

    expect(existsSync(layoutMarkerFile(root))).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith("legacy-"))).toBe(true);
    expect(existsSync(join(root, "issues"))).toBe(false);
  });

  test("stopping ends the retries without sweeping", async () => {
    const { root, daemon } = sweepingDaemon();
    const sweeping = daemon.sweepLegacyLayout();

    await Bun.sleep(100);
    daemon.stopped = true;
    daemon.pollAbort.abort();
    await sweeping;

    expect(existsSync(layoutMarkerFile(root))).toBe(false);
    expect(existsSync(join(root, "issues", "MUL-1"))).toBe(true);
  });

  test("a one-shot run reports the failure instead of retrying", async () => {
    const { daemon } = sweepingDaemon({ once: true });

    await expect(daemon.sweepLegacyLayout()).rejects.toThrow();
  });
});
