import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiRepoCache } from "@daemon/agent-runtime/repo/checkout.js";
import { prepareChatRepositories } from "@daemon/agent-runtime/workspace/chat-repos.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chat-repositories-"));
  roots.push(root);
  const workDir = join(root, "chat");
  mkdirSync(workDir);
  const cache = new MultiremiRepoCache(join(root, "cache"));
  return { root, workDir, cache, workspaceId: "workspace", chatSessionId: "chat-session", projectId: "project-a" };
}

function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.invalid");
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
  return { url: path, defaultBranch: "main" };
}

async function checkout(options: ReturnType<typeof fixture>, repo: { url: string }) {
  const prepared = await prepareChatRepositories({ ...options, repos: [repo] });
  await options.cache.sync(options.workspaceId, prepared.reposToSync);
  const result = await options.cache.createWorktree({
    ...options, repoUrl: repo.url, branchName: `chat/${options.chatSessionId}`, reuseExisting: true, skipFetch: true,
  });
  await prepared.recordCheckouts([{ repoUrl: repo.url, path: result.path, branch: result.branchName }]);
  return result;
}

describe("bound Chat managed repositories", () => {
  it("plans a first fetch, records checkout, then reuses the session worktree without fetch", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const initial = await prepareChatRepositories({ ...options, repos: [repo] });
    expect(initial.reposToSync).toEqual([repo]);
    const created = await checkout(options, repo);
    expect(created.branchName).toBe("chat/chat-session");
    const next = await prepareChatRepositories({ ...options, repos: [repo] });
    expect(next.repos).toEqual([repo]);
    expect(next.reposToSync).toEqual([]);
    expect(next.warnings).toEqual([]);
    const reused = await options.cache.createWorktree({
      ...options, repoUrl: repo.url, branchName: "chat/chat-session", reuseExisting: true, skipFetch: true,
    });
    expect(reused.created).toBe(false);
    expect(reused.path).toBe(created.path);
  });

  it("removes clean old Project worktrees through Git registration and retains unrelated directories", async () => {
    const options = fixture();
    const oldRepo = repository(options.root, "old/repo-a");
    const newRepo = repository(options.root, "new/repo-b");
    const old = await checkout(options, oldRepo);
    const unrelated = join(options.workDir, "user-files");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep"), "user work");
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [newRepo] });
    expect(existsSync(old.path)).toBe(false);
    expect(git(options.cache.lookup(options.workspaceId, oldRepo.url)!, "worktree", "list", "--porcelain")).not.toContain(old.path);
    expect(git(options.cache.lookup(options.workspaceId, oldRepo.url)!, "rev-parse", "refs/heads/chat/chat-session"))
      .toBe(git(oldRepo.url, "rev-parse", "HEAD"));
    expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("user work");
    expect(next.reposToSync).toEqual([newRepo]);
    expect(next.warnings).toEqual([]);
  });

  it("retains dirty work across A -> B -> C bindings and cleans it only after edits are resolved", async () => {
    const options = fixture();
    const repo = repository(options.root, "old/repo");
    const old = await checkout(options, repo);
    writeFileSync(join(old.path, "unfinished.txt"), "not committed");
    for (const projectId of ["project-b", "project-c"]) {
      const next = await prepareChatRepositories({ ...options, projectId, repos: [] });
      expect(next.warnings[0]?.message).toContain("project-a");
      expect(next.warnings[0]?.message).toContain("uncommitted changes");
      expect(next.warnings[0]?.message).toContain(old.path);
      expect(readFileSync(join(old.path, "unfinished.txt"), "utf8")).toBe("not committed");
    }
    rmSync(join(old.path, "unfinished.txt"));
    const final = await prepareChatRepositories({ ...options, projectId: "project-c", repos: [] });
    expect(final.warnings).toEqual([]);
    expect(existsSync(old.path)).toBe(false);
  });

  it("preserves clean-looking worktrees containing unpushed commits", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    writeFileSync(join(old.path, "README.md"), "unpublished commit\n");
    git(old.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", "unpublished");
    expect(git(old.path, "status", "--porcelain")).toBe("");
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [] });
    expect(next.warnings[0]?.message).toContain("unpushed commits");
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe("unpublished commit\n");
  });

  it("preserves Git-locked worktrees and reports the failed non-force removal", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    git(options.cache.lookup(options.workspaceId, repo.url)!, "worktree", "lock", old.path);
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [] });
    expect(next.warnings[0]?.message).toContain("locked");
    expect(existsSync(old.path)).toBe(true);
  });

  it("also preserves ignored files that Git worktree remove would otherwise discard", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    const barePath = options.cache.lookup(options.workspaceId, repo.url)!;
    mkdirSync(join(barePath, "info"), { recursive: true });
    writeFileSync(join(barePath, "info", "exclude"), "CLAUDE.md\n");
    writeFileSync(join(old.path, "CLAUDE.md"), "local instructions");
    expect(git(old.path, "status", "--porcelain")).toBe("");
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [] });
    expect(next.warnings[0]?.message).toContain("ignored local files");
    expect(readFileSync(join(old.path, "CLAUDE.md"), "utf8")).toBe("local instructions");
  });

  it("skips same-name repositories when an old dirty worktree occupies their destination", async () => {
    const options = fixture();
    const oldRepo = repository(options.root, "old/repo");
    const nextRepo = repository(options.root, "next/repo");
    const old = await checkout(options, oldRepo);
    writeFileSync(join(old.path, "unfinished.txt"), "keep");
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [nextRepo] });
    expect(next.repos).toEqual([]);
    expect(next.reposToSync).toEqual([]);
    expect(next.warnings).toHaveLength(2);
    expect(next.warnings[1]?.message).toContain("directory collision");
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe("old/repo\n");
  });

  it("does not adopt or overwrite an untracked worktree belonging to a different same-name URL", async () => {
    const options = fixture();
    const oldRepo = repository(options.root, "old/repo");
    const nextRepo = repository(options.root, "next/repo");
    const old = await checkout(options, oldRepo);
    rmSync(join(options.workDir, ".multiremi", "chat-repos.json"));
    await options.cache.sync(options.workspaceId, [nextRepo]);
    const next = await prepareChatRepositories({ ...options, repos: [nextRepo] });
    expect(next.repos).toEqual([]);
    expect(next.warnings[0]?.message).toContain("another repository");
    expect(() => options.cache.hasWorktree({ ...options, repoUrl: nextRepo.url }))
      .toThrow("another repository");
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe("old/repo\n");
  });

  it("does not fetch two same-name repositories into the same initially empty directory", async () => {
    const options = fixture();
    const repoA = repository(options.root, "a/repo");
    const repoB = repository(options.root, "b/repo");
    const next = await prepareChatRepositories({ ...options, repos: [repoA, repoB] });
    expect(next.repos).toEqual([repoA]);
    expect(next.reposToSync).toEqual([repoA]);
    expect(next.warnings[0]?.message).toContain("directory collision");
  });

  it("rejects metadata symlinks without modifying their targets", async () => {
    for (const kind of ["directory", "file"]) {
      const options = fixture();
      const external = join(options.root, "external");
      mkdirSync(external);
      const sentinel = join(external, "chat-repos.json");
      writeFileSync(sentinel, "external sentinel");
      if (kind === "directory") symlinkSync(external, join(options.workDir, ".multiremi"));
      else {
        mkdirSync(join(options.workDir, ".multiremi"));
        symlinkSync(sentinel, join(options.workDir, ".multiremi", "chat-repos.json"));
      }
      await expect(prepareChatRepositories({ ...options, repos: [] })).rejects.toThrow("unsafe");
      expect(readFileSync(sentinel, "utf8")).toBe("external sentinel");
    }
  });

  it("never removes a tracked worktree replaced with a symlink to external files", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    rmSync(old.path, { recursive: true });
    symlinkSync(repo.url, old.path);
    const next = await prepareChatRepositories({ ...options, projectId: "project-b", repos: [] });
    expect(next.warnings[0]?.message).toContain("unsafe");
    expect(readFileSync(join(repo.url, "README.md"), "utf8")).toBe("source/repo\n");
  });

  it("refuses manifests with outside paths or mismatched workspace/session identity", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    await checkout(options, repo);
    const path = join(options.workDir, ".multiremi", "chat-repos.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const edit of [
      { ...original, workspaceId: "other-workspace" },
      { ...original, chatSessionId: "other-session" },
      { ...original, entries: [{ ...original.entries[0], path: repo.url }] },
    ]) {
      writeFileSync(path, JSON.stringify(edit));
      await expect(prepareChatRepositories({ ...options, projectId: "project-b", repos: [] })).rejects.toThrow();
      expect(readFileSync(join(repo.url, "README.md"), "utf8")).toBe("source/repo\n");
    }
  });

  it("writes no metadata for a bound Project without explicit repositories", async () => {
    const options = fixture();
    const result = await prepareChatRepositories({ ...options, repos: [] });
    await result.recordCheckouts([]);
    expect(result.reposToSync).toEqual([]);
    expect(existsSync(join(options.workDir, ".multiremi"))).toBe(false);
  });
});
