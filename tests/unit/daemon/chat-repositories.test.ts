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

  it.each(["clean", "uncommitted", "unpushed"])("retains %s worktrees when the Project removes a repository resource", async (state) => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    if (state !== "clean") writeFileSync(join(old.path, "README.md"), "local work\n");
    if (state === "unpushed") {
      git(old.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", "unpublished");
    }
    const originalHead = git(old.path, "rev-parse", "HEAD");
    const manifestPath = join(options.workDir, ".multiremi", "chat-repos.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const next = await prepareChatRepositories({ ...options, repos: [] });
    await next.recordCheckouts([]);
    expect(next.repos).toEqual([]);
    expect(next.reposToSync).toEqual([]);
    expect(next.warnings).toEqual([]);
    expect(existsSync(old.path)).toBe(true);
    expect(git(old.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(old.path, "branch", "--show-current")).toBe("chat/chat-session");
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe(state === "clean" ? "source/repo\n" : "local work\n");
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
  });

  it("rejects a changed Project identity without removing files or rewriting provenance", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    const manifestPath = join(options.workDir, ".multiremi", "chat-repos.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    await expect(prepareChatRepositories({ ...options, projectId: "different-project", repos: [] }))
      .rejects.toThrow("does not match this workspace/session/project");
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe("source/repo\n");
  });

  it("skips new same-name repository resources when a worktree already occupies their destination", async () => {
    const options = fixture();
    const oldRepo = repository(options.root, "old/repo");
    const nextRepo = repository(options.root, "next/repo");
    const old = await checkout(options, oldRepo);
    writeFileSync(join(old.path, "unfinished.txt"), "keep");
    const next = await prepareChatRepositories({ ...options, repos: [nextRepo] });
    expect(next.repos).toEqual([]);
    expect(next.reposToSync).toEqual([]);
    expect(next.warnings).toHaveLength(1);
    expect(next.warnings[0]?.message).toContain("directory collision");
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

  it("refuses to reuse a tracked worktree replaced with a symlink to external files", async () => {
    const options = fixture();
    const repo = repository(options.root, "source/repo");
    const old = await checkout(options, repo);
    rmSync(old.path, { recursive: true });
    symlinkSync(repo.url, old.path);
    const next = await prepareChatRepositories({ ...options, repos: [repo] });
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
      { ...original, projectId: "other-project" },
      { ...original, entries: [{ ...original.entries[0], projectId: "other-project" }] },
      { ...original, entries: [{ ...original.entries[0], path: repo.url }] },
    ]) {
      writeFileSync(path, JSON.stringify(edit));
      await expect(prepareChatRepositories({ ...options, repos: [] })).rejects.toThrow();
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
