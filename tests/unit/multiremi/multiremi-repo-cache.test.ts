import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  MultiremiRepoCache,
  multiremiRepoCacheLockPath,
  repoCacheTimeoutOverrides,
  repoSyncBudgetMs,
} from "@multiremi/repo-cache.js";

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
  it("uses a remote-tracking fetch layout before creating agent worktrees", async () => {
    const source = createRepo("main", "main content");
    const cacheRoot = tempDir("multiremi-repo-cache-");
    const workDir = tempDir("multiremi-repo-work-");
    const cache = new MultiremiRepoCache(cacheRoot);

    await cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;

    expect(git(barePath, ["config", "--get", "remote.origin.fetch"])).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(git(barePath, ["rev-parse", "--verify", "refs/remotes/origin/main"])).toBeString();

    const result = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_repo_cache_layout",
    });

    expect(result.branchName).toStartWith("agent/codex/");
    expect(readFileSync(join(result.path, "README.md"), "utf8")).toContain("main content");
  });

  it("does not place repositories in reserved Issue workspace directories", async () => {
    const sourceParent = tempDir("multiremi-reserved-source-");
    const source = join(sourceParent, "wiki");
    initializeRepo(source, "main", "wiki repository");
    const cacheRoot = tempDir("multiremi-reserved-cache-");
    const workDir = tempDir("multiremi-reserved-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);

    const result = await cache.createWorktree({ workspaceId: "local", repoUrl: source, workDir });

    expect(basename(result.path)).toMatch(/^wiki-repo-[a-f0-9]{8}$/);
    expect(existsSync(join(workDir, "wiki"))).toBe(false);
  });

  it("reuseExisting keeps an existing worktree's branch and uncommitted work", async () => {
    const source = createRepo("main", "reuse repo");
    const cacheRoot = tempDir("multiremi-repo-reuse-");
    const workDir = tempDir("multiremi-repo-reuse-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);

    const first = await cache.createWorktree({
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

    const second = await cache.createWorktree({
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

  it("uses one explicit Issue branch and refuses to switch a reused workspace", async () => {
    const source = createRepo("main", "issue branch repo");
    const cacheRoot = tempDir("multiremi-repo-issue-");
    const workDir = tempDir("multiremi-repo-issue-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);

    const first = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      branchName: "agent/MUL-28",
      reuseExisting: true,
    });
    expect(first.branchName).toBe("agent/MUL-28");
    writeFileSync(join(first.path, "wip.txt"), "keep me\n");

    await expect(cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      branchName: "agent/MUL-29",
      reuseExisting: true,
    })).rejects.toThrow(/refusing to switch a persistent workspace/);
    expect(readFileSync(join(first.path, "wip.txt"), "utf8")).toBe("keep me\n");
  });

  it("creates immutable commit snapshots without git metadata and reuses them by commit", async () => {
    const source = createRepo("main", "snapshot v1");
    const cacheRoot = tempDir("multiremi-repo-snapshot-");
    const snapshotsRoot = tempDir("multiremi-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);

    const first = await cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
    });
    const reused = await cache.createSnapshot({
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
    await cache.sync("local", [{ url: source }]);

    const second = await cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
    });
    expect(second.commit).not.toBe(first.commit);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("snapshot v2\n");
    expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("snapshot v1\n");
  });

  it("mirrors a remote tag that moved to a newer commit", async () => {
    const source = createRepo("main", "tagged snapshot v1");
    const cacheRoot = tempDir("multiremi-repo-moved-tag-");
    const snapshotsRoot = tempDir("multiremi-moved-tag-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot);
    const movingTag = "agent-server-kit-main-last-notified";

    git(source, ["tag", movingTag]);
    await cache.sync("local", [{ url: source }]);
    const first = await cache.createSnapshot({
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

    const second = await cache.createSnapshot({
      workspaceId: "local",
      repoUrl: source,
      snapshotsRoot,
      ref: movingTag,
    });

    expect(second.commit).toBe(movedCommit);
    expect(second.commit).not.toBe(first.commit);
    expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("tagged snapshot v2\n");
  });

  it("retries transient network failures while refreshing a cached repository", async () => {
    const source = createRepo("main", "retry snapshot");
    const cacheRoot = tempDir("multiremi-repo-retry-cache-");
    const snapshotsRoot = tempDir("multiremi-repo-retry-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot, { fetchRetryDelaysMs: [0, 0] });
    await cache.sync("local", [{ url: source }]);

    const attempts = tempDir("multiremi-repo-retry-attempts-");
    const restorePath = installGitFetchWrapper(attempts, 2, "ssh: connect to host code.byted.org port 22: Connection timed out");
    try {
      const snapshot = await cache.createSnapshot({ workspaceId: "local", repoUrl: source, snapshotsRoot });
      expect(readFileSync(join(snapshot.path, "README.md"), "utf8")).toBe("retry snapshot\n");
      expect(readFetchAttempts(attempts)).toBe(3);
    } finally {
      restorePath();
    }
  });

  it("does not retry deterministic fetch failures", async () => {
    const source = createRepo("main", "auth failure snapshot");
    const cacheRoot = tempDir("multiremi-repo-no-retry-cache-");
    const snapshotsRoot = tempDir("multiremi-repo-no-retry-snapshots-");
    const cache = new MultiremiRepoCache(cacheRoot, { fetchRetryDelaysMs: [0, 0] });
    await cache.sync("local", [{ url: source }]);

    const attempts = tempDir("multiremi-repo-no-retry-attempts-");
    const restorePath = installGitFetchWrapper(attempts, Number.MAX_SAFE_INTEGER, "Permission denied (publickey)");
    try {
      await expect(cache.createSnapshot({ workspaceId: "local", repoUrl: source, snapshotsRoot }))
        .rejects.toThrow(/Permission denied \(publickey\)/);
      expect(readFetchAttempts(attempts)).toBe(1);
    } finally {
      restorePath();
    }
  });

  it("times out a hung fetch without blocking the event loop and keeps an existing cache", async () => {
    const source = createRepo("main", "hung fetch cache");
    const cacheRoot = tempDir("multiremi-repo-hung-fetch-cache-");
    const initialCache = new MultiremiRepoCache(cacheRoot);
    await initialCache.sync("local", [{ url: source }]);
    const barePath = initialCache.lookup("local", source)!;
    const wrapperRoot = tempDir("multiremi-repo-hung-fetch-wrapper-");
    const restorePath = installHangingGitWrapper(wrapperRoot, "fetch");
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [0, 0],
      fetchTimeoutMs: 40,
      repoSyncTimeoutMs: 400,
      processKillGraceMs: 20,
    });
    let ticks = 0;
    const ticker = setInterval(() => ticks += 1, 5);
    const startedAt = Date.now();
    try {
      const result = await cache.sync("local", [{ url: source }]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ repoUrl: source, status: "cached" });
      expect(result[0]?.error).toContain("timed out after 40ms");
      expect(readFetchAttempts(wrapperRoot)).toBe(3);
      expect(ticks).toBeGreaterThan(5);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(existsSync(multiremiRepoCacheLockPath(barePath))).toBe(false);
      await expectRecordedProcessesToExit(wrapperRoot);
    } finally {
      clearInterval(ticker);
      restorePath();
    }
  });

  it("bounds a hung remote set-head without blocking the event loop", async () => {
    const source = createRepo("main", "hung remote set-head cache");
    const cacheRoot = tempDir("multiremi-repo-hung-set-head-cache-");
    const initialCache = new MultiremiRepoCache(cacheRoot);
    await initialCache.sync("local", [{ url: source }]);
    const barePath = initialCache.lookup("local", source)!;
    const wrapperRoot = tempDir("multiremi-repo-hung-set-head-wrapper-");
    const restorePath = installHangingGitWrapper(wrapperRoot, "remote-set-head", 3);
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [],
      fetchTimeoutMs: 250,
      repoSyncTimeoutMs: 900,
      processKillGraceMs: 20,
    });
    let ticks = 0;
    let lastTickAt = Date.now();
    let maxTickGapMs = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      ticks += 1;
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt);
      lastTickAt = now;
    }, 5);
    const startedAt = Date.now();
    try {
      const result = await cache.sync("local", [{ url: source }]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result).toEqual([{ repoUrl: source, status: "fresh", error: null }]);
      expect(readFetchAttempts(wrapperRoot)).toBe(1);
      expect(ticks).toBeGreaterThan(0);
      expect(maxTickGapMs).toBeLessThan(1_500);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(existsSync(multiremiRepoCacheLockPath(barePath))).toBe(false);
      await expectRecordedProcessesToExit(wrapperRoot);
    } finally {
      clearInterval(ticker);
      restorePath();
    }
  });

  it("returns a bounded failure when a first clone hangs", async () => {
    const source = createRepo("main", "hung clone");
    const cacheRoot = tempDir("multiremi-repo-hung-clone-cache-");
    const wrapperRoot = tempDir("multiremi-repo-hung-clone-wrapper-");
    const restorePath = installHangingGitWrapper(wrapperRoot, "clone");
    const cache = new MultiremiRepoCache(cacheRoot, {
      cloneTimeoutMs: 1_000,
      repoSyncTimeoutMs: 40,
      processKillGraceMs: 20,
    });
    try {
      // Initial materialization runs under repoSyncBudgetMs (sync + 2x clone),
      // so the hung clone is bounded by its own cloneTimeoutMs, not the
      // refresh budget — which would otherwise make cloneTimeoutMs unreachable.
      const startedAt = Date.now();
      const result = await cache.sync("local", [{ url: source }]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ repoUrl: source, status: "failed" });
      expect(result[0]?.error).toContain("timed out after 1000ms");
      expect(Date.now() - startedAt).toBeLessThan(repoSyncBudgetMs({ cloneTimeoutMs: 1_000, repoSyncTimeoutMs: 40 }, false));
      expect(cache.lookup("local", source)).toBeNull();
      await expectRecordedProcessesToExit(wrapperRoot);
    } finally {
      restorePath();
    }
  });

  it("retries a transient broker HTTPS fetch without losing the original repository identity", async () => {
    const source = createRepo("main", "broker retry");
    const cacheRoot = tempDir("multiremi-repo-broker-retry-cache-");
    const wrapperRoot = tempDir("multiremi-repo-broker-retry-wrapper-");
    const repositoryUrl = "git@example.test:team/repo.git";
    const httpsUrl = "https://example.test/team/repo.git";
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [0, 0],
      credentialBroker: brokerOptions(),
    });
    const restorePath = installGitTransportWrapper(wrapperRoot, {
      source,
      repositoryUrl,
      httpsUrl,
      explicitFetchFailures: 2,
    });
    try {
      await cache.sync("wsp_broker", [{ url: repositoryUrl }]);
      await cache.sync("wsp_broker", [{ url: repositoryUrl }]);
    } finally {
      restorePath();
    }

    const barePath = cache.lookup("wsp_broker", repositoryUrl)!;
    expect(readFetchAttempts(wrapperRoot)).toBe(3);
    expect(readFileSync(join(wrapperRoot, "broker-workspace"), "utf8")).toBe("wsp_broker");
    expect(git(barePath, ["remote", "get-url", "origin"])).toBe(httpsUrl);
    expect(git(barePath, ["config", "--get", "multiremi.repository-url"])).toBe(repositoryUrl);
  });

  it("falls back to the original transport when the broker clone path is unavailable", async () => {
    const source = createRepo("main", "broker fallback");
    const cacheRoot = tempDir("multiremi-repo-broker-fallback-cache-");
    const wrapperRoot = tempDir("multiremi-repo-broker-fallback-wrapper-");
    const repositoryUrl = "git@example.test:team/repo.git";
    const httpsUrl = "https://example.test/team/repo.git";
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [0, 0],
      credentialBroker: brokerOptions(),
    });
    const restorePath = installGitTransportWrapper(wrapperRoot, {
      source,
      repositoryUrl,
      httpsUrl,
      failBrokerClone: true,
    });
    try {
      await cache.sync("wsp_fallback", [{ url: repositoryUrl }]);
    } finally {
      restorePath();
    }

    const barePath = cache.lookup("wsp_fallback", repositoryUrl)!;
    expect(readFileSync(join(wrapperRoot, "clone-urls"), "utf8").trim().split("\n"))
      .toEqual([httpsUrl, repositoryUrl]);
    expect(git(barePath, ["remote", "get-url", "origin"])).toBe(repositoryUrl);
  });

  it("falls back to the original transport without broker env when broker fetch is unavailable", async () => {
    const source = createRepo("main", "broker fetch fallback");
    const cacheRoot = tempDir("multiremi-repo-broker-fetch-fallback-cache-");
    const wrapperRoot = tempDir("multiremi-repo-broker-fetch-fallback-wrapper-");
    const repositoryUrl = "git@example.test:team/repo.git";
    const httpsUrl = "https://example.test/team/repo.git";
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [0, 0],
      credentialBroker: brokerOptions(),
    });
    const restorePath = installGitTransportWrapper(wrapperRoot, {
      source,
      repositoryUrl,
      httpsUrl,
      failBrokerFetch: true,
    });
    try {
      await cache.sync("wsp_fetch_fallback", [{ url: repositoryUrl }]);
      await cache.sync("wsp_fetch_fallback", [{ url: repositoryUrl }]);
    } finally {
      restorePath();
    }

    const barePath = cache.lookup("wsp_fetch_fallback", repositoryUrl)!;
    expect(Number(readFileSync(join(wrapperRoot, "plain-fetches"), "utf8"))).toBeGreaterThanOrEqual(1);
    expect(git(barePath, ["remote", "get-url", "origin"])).toBe(repositoryUrl);
  });

  it("preserves custom-port SSH transports when broker HTTPS conversion is unsafe", async () => {
    const source = createRepo("main", "custom ssh transport");
    const cacheRoot = tempDir("multiremi-repo-custom-ssh-cache-");
    const wrapperRoot = tempDir("multiremi-repo-custom-ssh-wrapper-");
    const repositoryUrl = "ssh://git@example.test:2222/team/repo.git";
    const cache = new MultiremiRepoCache(cacheRoot, {
      fetchRetryDelaysMs: [0, 0],
      credentialBroker: brokerOptions(),
    });
    const restorePath = installGitTransportWrapper(wrapperRoot, {
      source,
      repositoryUrl,
      httpsUrl: repositoryUrl,
    });
    try {
      await expect(cache.sync("wsp_custom_ssh", [{ url: repositoryUrl }])).resolves.toEqual([
        { repoUrl: repositoryUrl, status: "fresh", error: null },
      ]);
    } finally {
      restorePath();
    }

    const barePath = cache.lookup("wsp_custom_ssh", repositoryUrl)!;
    expect(readFileSync(join(wrapperRoot, "clone-urls"), "utf8").trim()).toBe(repositoryUrl);
    expect(git(barePath, ["remote", "get-url", "origin"])).toBe(repositoryUrl);
  });

  it("serializes repo mutations with lock dirs and recovers stale locks", async () => {
    const source = createRepo("main", "locked repo");
    const cacheRoot = tempDir("multiremi-repo-lock-");
    const workDir = tempDir("multiremi-repo-lock-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;
    const lockPath = multiremiRepoCacheLockPath(barePath);

    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "holder.json"), JSON.stringify({ pid: process.pid }));
    try {
      const lockedCache = new MultiremiRepoCache(cacheRoot, { lockTimeoutMs: 25, staleLockMs: 60_000 });
      await expect(lockedCache.createWorktree({
        workspaceId: "local",
        repoUrl: source,
        workDir,
        agentName: "Claude",
        taskId: "tsk_locked",
      })).rejects.toThrow(/timed out waiting for repo cache lock/);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }

    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    if (!exited.pid) throw new Error("expected exited lock-holder PID");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "holder.json"), JSON.stringify({ pid: exited.pid }));
    const deadOwnerAwareCache = new MultiremiRepoCache(cacheRoot, { lockTimeoutMs: 500, staleLockMs: 60_000 });
    expect((await deadOwnerAwareCache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_dead_lock_owner",
    })).path).toContain("repo");

    mkdirSync(lockPath);
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lockPath, stale, stale);
    const staleAwareCache = new MultiremiRepoCache(cacheRoot, { lockTimeoutMs: 500, staleLockMs: 1 });
    const result = await staleAwareCache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_stale_lock",
    });

    expect(result.path).toContain("repo");
  });

  it("prunes stale metadata for the target repo before recreating its worktree", async () => {
    const source = createRepo("main", "prune repo");
    const cacheRoot = tempDir("multiremi-repo-prune-");
    const workDir = tempDir("multiremi-repo-prune-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;
    const result = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_prune",
    });

    rmSync(result.path, { recursive: true, force: true });
    expect(git(barePath, ["worktree", "list", "--porcelain"])).toContain(result.path);

    const recreated = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      branchName: result.branchName,
      agentName: "Codex",
      taskId: "tsk_prune",
    });

    expect(recreated.created).toBe(true);
    expect(recreated.path).toBe(result.path);
    expect(existsSync(recreated.path)).toBe(true);
    const registrations = git(barePath, ["worktree", "list", "--porcelain"]);
    expect(registrations.split(recreated.path).length - 1).toBe(1);
  });

  it("installs and removes the daemon co-authored-by hook from agent worktrees", async () => {
    const source = createRepo("main", "hook repo");
    const cacheRoot = tempDir("multiremi-repo-hook-");
    const workDir = tempDir("multiremi-repo-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);

    const result = await cache.createWorktree({
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
    expect(git(result.path, ["log", "-1", "--format=%B"])).toContain("Co-authored-by: Remi <remi@openremi.fun>");

    await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_hook",
      reuseExisting: true,
      coAuthoredByEnabled: false,
    });
    expect(existsSync(hookPath)).toBe(false);
  });

  it("upgrades a legacy hook while reusing an existing worktree", async () => {
    const source = createRepo("main", "legacy hook repo");
    const cacheRoot = tempDir("multiremi-repo-legacy-hook-");
    const workDir = tempDir("multiremi-repo-legacy-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const result = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      taskId: "tsk_legacy_hook",
      coAuthoredByEnabled: false,
    });
    const hookPath = prepareCommitMsgHookPath(result.path);
    writeFileSync(hookPath, `#!/bin/sh
# multimira:prepare-commit-msg:co-authored-by
# Installed by the Multimira daemon.
git interpret-trailers --in-place --trailer "Co-authored-by: Multimira Agent <github@multimira.ai>" "$1"
`, { mode: 0o755 });

    const reused = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      taskId: "tsk_legacy_hook",
      reuseExisting: true,
      coAuthoredByEnabled: true,
    });

    expect(reused.created).toBe(false);
    const upgraded = readFileSync(hookPath, "utf8");
    expect(upgraded).toContain("Co-authored-by: Remi <remi@openremi.fun>");
    expect(upgraded).not.toContain("Multimira Agent");
  });

  it("chains and restores an existing user prepare-commit-msg hook", async () => {
    const source = createRepo("main", "chained hook repo");
    const cacheRoot = tempDir("multiremi-repo-chained-hook-");
    const workDir = tempDir("multiremi-repo-chained-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const result = await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      taskId: "tsk_chained_hook",
      coAuthoredByEnabled: false,
    });
    const hookPath = prepareCommitMsgHookPath(result.path);
    const userHook = `#!/bin/sh
git interpret-trailers --in-place --trailer "User-Hook: preserved" "$1"
`;
    writeFileSync(hookPath, userHook, { mode: 0o755 });

    await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      taskId: "tsk_chained_hook",
      reuseExisting: true,
      coAuthoredByEnabled: true,
    });
    const managed = readFileSync(hookPath, "utf8");
    expect(managed).toContain("# multiremi:chained-hook-suffix=");
    git(result.path, ["config", "user.email", "agent@example.test"]);
    git(result.path, ["config", "user.name", "Agent"]);
    writeFileSync(join(result.path, "chain.txt"), "chain\n");
    git(result.path, ["add", "chain.txt"]);
    git(result.path, ["commit", "-m", "chained hooks"]);
    const message = git(result.path, ["log", "-1", "--format=%B"]);
    expect(message).toContain("User-Hook: preserved");
    expect(message).toContain("Co-authored-by: Remi <remi@openremi.fun>");

    await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      taskId: "tsk_chained_hook",
      reuseExisting: true,
      coAuthoredByEnabled: false,
    });
    expect(readFileSync(hookPath, "utf8")).toBe(userHook);
  });

  it("preserves user prepare-commit-msg hooks when co-authored-by is disabled", async () => {
    const source = createRepo("main", "user hook repo");
    const cacheRoot = tempDir("multiremi-repo-user-hook-");
    const workDir = tempDir("multiremi-repo-user-hook-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const result = await cache.createWorktree({
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

    await cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Claude",
      taskId: "tsk_user_hook",
      coAuthoredByEnabled: false,
    });

    expect(readFileSync(hookPath, "utf8")).toBe(userHook);
  });

  it("fails ambiguous default branches instead of guessing a stale bare HEAD", async () => {
    const source = createRepo("alpha", "alpha");
    git(source, ["checkout", "-b", "beta"]);
    writeFileSync(join(source, "README.md"), "beta\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "beta"]);

    const cacheRoot = tempDir("multiremi-repo-ambiguous-");
    const workDir = tempDir("multiremi-repo-ambiguous-work-");
    const cache = new MultiremiRepoCache(cacheRoot);
    await cache.sync("local", [{ url: source }]);
    const barePath = cache.lookup("local", source)!;

    tryGit(barePath, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    git(barePath, ["symbolic-ref", "HEAD", "refs/heads/legacy"]);
    git(barePath, ["remote", "set-url", "origin", join(tempDir("multiremi-missing-remote-"), "missing")]);

    await expect(cache.createWorktree({
      workspaceId: "local",
      repoUrl: source,
      workDir,
      agentName: "Codex",
      taskId: "tsk_ambiguous",
    })).rejects.toThrow(/origin\/\* is empty or ambiguous/);
  }, 15_000);
});

describe("Multiremi repo sync budgets", () => {
  it("gives initial materialization clone room on top of the refresh budget", () => {
    // Defaults: refresh 300s; initial adds 2x clone (preferred + fallback URL).
    expect(repoSyncBudgetMs({}, true)).toBe(300_000);
    expect(repoSyncBudgetMs({}, false)).toBe(300_000 + 2 * 600_000);
    expect(repoSyncBudgetMs({ repoSyncTimeoutMs: 1_000, cloneTimeoutMs: 2_000 }, true)).toBe(1_000);
    expect(repoSyncBudgetMs({ repoSyncTimeoutMs: 1_000, cloneTimeoutMs: 2_000 }, false)).toBe(5_000);
  });

  it("parses timeout overrides from the environment and drops invalid values", () => {
    expect(repoCacheTimeoutOverrides({})).toEqual({});
    expect(repoCacheTimeoutOverrides({
      MULTIREMI_REPO_FETCH_TIMEOUT_MS: "60000",
      MULTIREMI_REPO_CLONE_TIMEOUT_MS: "120000",
      MULTIREMI_REPO_SYNC_TIMEOUT_MS: "180000",
    })).toEqual({ fetchTimeoutMs: 60_000, cloneTimeoutMs: 120_000, repoSyncTimeoutMs: 180_000 });
    expect(repoCacheTimeoutOverrides({
      MULTIREMI_REPO_FETCH_TIMEOUT_MS: "0",
      MULTIREMI_REPO_CLONE_TIMEOUT_MS: "-5",
      MULTIREMI_REPO_SYNC_TIMEOUT_MS: "not-a-number",
    })).toEqual({});
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

function installGitFetchWrapper(root: string, failures: number, failureMessage: string): () => void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = join(root, "bin");
  const attemptsFile = join(root, "attempts");
  mkdirSync(wrapperDir);
  writeFileSync(join(wrapperDir, "git"), `#!/bin/sh
case " $* " in
  *" fetch "*)
    attempts=0
    if [ -f ${shellQuote(attemptsFile)} ]; then attempts=$(cat ${shellQuote(attemptsFile)}); fi
    attempts=$((attempts + 1))
    printf '%s' "$attempts" > ${shellQuote(attemptsFile)}
    if [ "$attempts" -le ${failures} ]; then
      printf '%s\\n' ${shellQuote(failureMessage)} >&2
      exit 128
    fi
    ;;
esac
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  return prependPath(wrapperDir);
}

function installHangingGitWrapper(
  root: string,
  operation: "fetch" | "clone" | "remote-set-head",
  hangSeconds = 30,
): () => void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = join(root, "bin");
  const attemptsFile = join(root, "attempts");
  const pidsFile = join(root, "pids");
  const operationCondition = operation === "remote-set-head"
    ? '[ "$1" = "remote" ] && [ "$2" = "set-head" ]'
    : `[ "$1" = ${shellQuote(operation)} ]`;
  mkdirSync(wrapperDir);
  writeFileSync(join(wrapperDir, "git"), `#!/bin/sh
if ${operationCondition}; then
  attempts=0
  if [ -f ${shellQuote(attemptsFile)} ]; then attempts=$(cat ${shellQuote(attemptsFile)}); fi
  attempts=$((attempts + 1))
  printf '%s' "$attempts" > ${shellQuote(attemptsFile)}
  printf '%s\\n' "$$" >> ${shellQuote(pidsFile)}
  trap '' TERM
  sh -c 'trap "" TERM; exec sleep ${hangSeconds}' &
  printf '%s\\n' "$!" >> ${shellQuote(pidsFile)}
  wait
fi
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  return prependPath(wrapperDir);
}

function installGitTransportWrapper(
  root: string,
  options: {
    source: string;
    repositoryUrl: string;
    httpsUrl: string;
    explicitFetchFailures?: number;
    failBrokerClone?: boolean;
    failBrokerFetch?: boolean;
  },
): () => void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = join(root, "bin");
  const attemptsFile = join(root, "attempts");
  const cloneUrlsFile = join(root, "clone-urls");
  const brokerWorkspaceFile = join(root, "broker-workspace");
  const plainFetchesFile = join(root, "plain-fetches");
  mkdirSync(wrapperDir);
  writeFileSync(join(wrapperDir, "git"), `#!/bin/sh
if [ "$1" = "clone" ] && [ "$2" = "--bare" ]; then
  printf '%s\\n' "$3" >> ${shellQuote(cloneUrlsFile)}
  if [ "${options.failBrokerClone ? "1" : "0"}" = "1" ] && [ -n "\${MULTIREMI_SERVER_URL:-}" ] && [ "$3" = ${shellQuote(options.httpsUrl)} ]; then
    printf '%s\\n' 'credential broker unavailable' >&2
    exit 128
  fi
  if [ "$3" = ${shellQuote(options.httpsUrl)} ] || [ "$3" = ${shellQuote(options.repositoryUrl)} ]; then
    exec ${shellQuote(realGit)} clone --bare ${shellQuote(options.source)} "$4"
  fi
fi
if [ "$1" = "fetch" ]; then
  remote="$4"
  if [ -n "\${MULTIREMI_SERVER_URL:-}" ]; then
    printf '%s' "\${MULTIREMI_WORKSPACE_ID:-}" > ${shellQuote(brokerWorkspaceFile)}
    if [ "${options.failBrokerFetch ? "1" : "0"}" = "1" ]; then
      printf '%s\\n' 'credential broker unavailable' >&2
      exit 128
    fi
  else
    plain=0
    if [ -f ${shellQuote(plainFetchesFile)} ]; then plain=$(cat ${shellQuote(plainFetchesFile)}); fi
    plain=$((plain + 1))
    printf '%s' "$plain" > ${shellQuote(plainFetchesFile)}
  fi
  if [ "$remote" = ${shellQuote(options.httpsUrl)} ]; then
    attempts=0
    if [ -f ${shellQuote(attemptsFile)} ]; then attempts=$(cat ${shellQuote(attemptsFile)}); fi
    attempts=$((attempts + 1))
    printf '%s' "$attempts" > ${shellQuote(attemptsFile)}
    if [ "$attempts" -le ${options.explicitFetchFailures ?? 0} ]; then
      printf '%s\\n' 'Connection timed out' >&2
      exit 128
    fi
  fi
  exec ${shellQuote(realGit)} fetch --prune --prune-tags ${shellQuote(options.source)} "$5" "$6"
fi
if [ "$1" = "remote" ] && [ "$2" = "set-head" ]; then
  exit 0
fi
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  return prependPath(wrapperDir);
}

function prependPath(wrapperDir: string): () => void {
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDir}:${previousPath ?? ""}`;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  };
}

function readFetchAttempts(root: string): number {
  return Number.parseInt(readFileSync(join(root, "attempts"), "utf8"), 10);
}

async function expectRecordedProcessesToExit(root: string): Promise<void> {
  const pids = readFileSync(join(root, "pids"), "utf8")
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const deadline = Date.now() + 1_000;
  while (pids.some(processExists) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pids.every((pid) => !processExists(pid))).toBe(true);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code !== "ESRCH"
    );
  }
}

function brokerOptions() {
  return {
    serverUrl: "https://multiremi.example",
    token: "daemon-token",
    helperCommand: "'remi' git-credential",
    fallbackHelpers: [],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
