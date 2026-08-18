import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { MultiremiRepoCache, multiremiRepoCacheLockPath } from "@multiremi/repo-cache.js";

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

describe("Multiremi repo cache", () => {
  it("uses a remote-tracking fetch layout before creating agent worktrees", () => {
    const source = createRepo("main", "main content");
    const cacheRoot = tempDir("multiremi-repo-cache-");
    const workDir = tempDir("multiremi-repo-work-");
    const cache = new MultiremiRepoCache(cacheRoot);

    cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;

    expect(git(barePath, ["config", "--get", "remote.origin.fetch"])).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(git(barePath, ["rev-parse", "--verify", "refs/remotes/origin/main"])).toBeString();

    const result = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_repo_cache_layout",
    });

    expect(result.branchName).toStartWith("agent/codex/");
    expect(readFileSync(join(result.path, "README.md"), "utf8")).toContain("main content");
  });

  it("does not place repositories in reserved Issue workspace directories", () => {
    const sourceParent = tempDir("multiremi-reserved-source-");
    const source = join(sourceParent, "wiki");
    initializeRepo(source, "main", "wiki repository");
    const cacheRoot = tempDir("multiremi-reserved-cache-");
    const workDir = tempDir("multiremi-reserved-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);

    const result = cache.createWorktree({ workspaceId: "local", repoUrl: source, workDir });

    expect(basename(result.path)).toMatch(/^wiki-repo-[a-f0-9]{8}$/);
    expect(existsSync(join(workDir, "wiki"))).toBe(false);
  });

  it("reuseExisting keeps an existing worktree's branch and uncommitted work", () => {
    const source = createRepo("main", "reuse repo");
    const cacheRoot = tempDir("multiremi-repo-reuse-");
    const workDir = tempDir("multiremi-repo-reuse-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);

    const first = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "REMI-42",
      reuseExisting: true,
    });
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("agent/claude/REMI-42");

    writeFileSync(join(first.path, "wip.txt"), "uncommitted\n");

    const second = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "REMI-42",
      reuseExisting: true,
    });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(second.branchName).toBe(first.branchName);
    expect(readFileSync(join(first.path, "wip.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("uses one explicit Issue branch and refuses to switch a reused workspace", () => {
    const source = createRepo("main", "issue branch repo");
    const cacheRoot = tempDir("multiremi-repo-issue-");
    const workDir = tempDir("multiremi-repo-issue-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);

    const first = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      branchName: "agent/MUL-28",
      reuseExisting: true,
    });
    expect(first.branchName).toBe("agent/MUL-28");
    writeFileSync(join(first.path, "wip.txt"), "keep me\n");

    expect(() => cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      branchName: "agent/MUL-29",
      reuseExisting: true,
    })).toThrow(/refusing to switch a persistent workspace/);
    expect(readFileSync(join(first.path, "wip.txt"), "utf8")).toBe("keep me\n");
  });

  it("creates immutable commit snapshots without git metadata and reuses them by commit", () => {
    const source = createRepo("main", "snapshot v1");
    const cacheRoot = tempDir("multiremi-repo-snapshot-");
    const snapshotsRoot = tempDir("multiremi-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);

    const first = cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
    });
    const reused = cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
    });

    expect(reused).toMatchObject({
      path: first.path,
      commit: first.commit,
      baseRef: first.baseRef,
      created: false,
    });
    expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("snapshot v1\n");
    expect(existsSync(join(first.path, ".git"))).toBe(false);
    expect(statSync(first.path).mode & 0o222).toBe(0);
    expect(statSync(join(first.path, "README.md")).mode & 0o222).toBe(0);

    writeFileSync(join(source, "README.md"), "snapshot v2\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "snapshot v2"]);
    cache.sync("local", [{ url: source }]);

    const second = cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
    });
    expect(second.commit).not.toBe(first.commit);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("snapshot v2\n");
    expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("snapshot v1\n");
  });

  it("mirrors a remote tag that moved to a newer commit", () => {
    const source = createRepo("main", "tagged snapshot v1");
    const cacheRoot = tempDir("multiremi-repo-moved-tag-");
    const snapshotsRoot = tempDir("multiremi-moved-tag-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot);
    const movingTag = "agent-server-kit-main-last-notified";

    git(source, ["tag", movingTag]);
    cache.sync("local", [{ url: source }]);
    const first = cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
      ref: movingTag,
    });

    writeFileSync(join(source, "README.md"), "tagged snapshot v2\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "move tag target"]);
    const movedCommit = git(source, ["rev-parse", "HEAD"]);
    git(source, ["tag", "--force", movingTag]);

    const second = cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
      ref: movingTag,
    });

    expect(second.commit).toBe(movedCommit);
    expect(second.commit).not.toBe(first.commit);
    expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("tagged snapshot v2\n");
  });

  it("serializes repo mutations with lock dirs and recovers stale locks", () => {
    const source = createRepo("main", "locked repo");
    const cacheRoot = tempDir("multiremi-repo-lock-");
    const workDir = tempDir("multiremi-repo-lock-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;
    const lockPath = multiremiRepoCacheLockPath(barePath);

    mkdirSync(lockPath);
    try {
      const lockedCache = new MultiremiRepoCache(cacheRoot, { lockTimeoutMs: 25, staleLockMs: 60_000 });
      expect(() => lockedCache.createWorktree({
        workspaceId: "local",
        repoUrl: source,
        workDir,
        agentName: "Claude",
        taskId: "tsk_locked",
      })).toThrow(/timed out waiting for repo cache lock/);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }

    mkdirSync(lockPath);
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lockPath, stale, stale);
    const staleAwareCache = new MultiremiRepoCache(cacheRoot, { lockTimeoutMs: 500, staleLockMs: 1 });
    const result = staleAwareCache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_stale_lock",
    });

    expect(result.path).toContain("repo");
  });

  it("prunes stale git worktree metadata from cached bare repos", () => {
    const source = createRepo("main", "prune repo");
    const cacheRoot = tempDir("multiremi-repo-prune-");
    const workDir = tempDir("multiremi-repo-prune-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;
    const result = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_prune",
    });

    rmSync(result.path, { recursive: true, force: true });
    expect(git(barePath, ["worktree", "list", "--porcelain"])).toContain(result.path);

    expect(cache.pruneWorktrees()).toBe(1);
    expect(git(barePath, ["worktree", "list", "--porcelain"])).not.toContain(result.path);
  });

  it("installs and removes the daemon co-authored-by hook from agent worktrees", () => {
    const source = createRepo("main", "hook repo");
    const cacheRoot = tempDir("multiremi-repo-hook-");
    const workDir = tempDir("multiremi-repo-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);

    const result = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_hook",
    });
    const hookPath = prepareCommitMsgHookPath(result.path);
    const hook = readFileSync(hookPath, "utf8");

    expect(hook).toContain("# multiremi:prepare-commit-msg:co-authored-by");
    expect(hook).toContain("# Installed by the Multiremi daemon.");
    expect(hook).not.toContain("multimira");
    expect(hook).not.toContain("Multimira");
    git(result.path, ["config", "user.email", "agent@example.test"]);
    git(result.path, ["config", "user.name", "Agent"]);
    writeFileSync(join(result.path, "agent.txt"), "agent change\n");
    git(result.path, ["add", "agent.txt"]);
    git(result.path, ["commit", "-m", "agent change"]);
    expect(git(result.path, ["log", "-1", "--format=%B"])).toContain("Co-authored-by: multiremi-agent <github@multiremi.ai>");

    cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_hook",
      coAuthoredByEnabled: false,
    });
    expect(existsSync(hookPath)).toBe(false);
  });

  it("preserves user prepare-commit-msg hooks when co-authored-by is disabled", () => {
    const source = createRepo("main", "user hook repo");
    const cacheRoot = tempDir("multiremi-repo-user-hook-");
    const workDir = tempDir("multiremi-repo-user-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);
    const result = cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_user_hook",
      coAuthoredByEnabled: false,
    });
    const hookPath = prepareCommitMsgHookPath(result.path);
    const userHook = "#!/bin/sh\n# user hook\n";
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, userHook, { mode: 0o755 });

    cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_user_hook",
      coAuthoredByEnabled: false,
    });

    expect(readFileSync(hookPath, "utf8")).toBe(userHook);
  });

  it("fails ambiguous default branches instead of guessing a stale bare HEAD", () => {
    const source = createRepo("alpha", "alpha");
    git(source, ["checkout", "-b", "beta"]);
    writeFileSync(join(source, "README.md"), "beta\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "beta"]);

    const cacheRoot = tempDir("multiremi-repo-ambiguous-");
    const workDir = tempDir("multiremi-repo-ambiguous-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;

    tryGit(barePath, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    git(barePath, ["symbolic-ref", "HEAD", "refs/heads/legacy"]);
    git(barePath, ["remote", "set-url", "origin", join(tempDir("multiremi-missing-remote-"), "missing")]);

    expect(() => cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_ambiguous",
    })).toThrow(/origin\/\* is empty or ambiguous/);
  });
});

function createRepo(branch: string, readme: string): string {
  const dir = tempDir("multiremi-source-repo-");
  initializeRepo(dir, branch, readme);
  return dir;
}

function initializeRepo(dir: string, branch: string, readme: string): void {
  execFileSync("git", ["init", "-b", branch, dir], { env: gitEnv(), stdio: "pipe" });
  git(dir, ["config", "user.email", "multiremi@example.test"]);
  git(dir, ["config", "user.name", "Multiremi Test"]);
  writeFileSync(join(dir, "README.md"), `${readme}\n`);
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    // Best-effort helper for optional git refs in tests.
  }
}

function prepareCommitMsgHookPath(worktreePath: string): string {
  const commonDir = git(worktreePath, ["rev-parse", "--git-common-dir"]);
  return join(isAbsolute(commonDir) ? commonDir : join(worktreePath, commonDir), "hooks", "prepare-commit-msg");
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}
