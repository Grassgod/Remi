import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatRepoStartupBudgetMs, MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chat-repository-startup-"));
  roots.push(root);
  const workDir = join(root, "chats", "chat_test");
  mkdirSync(workDir, { recursive: true });
  const repoCache = new MultiremiRepoCache(join(root, "cache"));
  const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
    repoCache, options: { workspacesRoot: root }, workspaceRepoUrls: new Map(), workspaceSettings: new Map(),
    assertWorkspaceRootOwner: () => {}, enqueueTaskReport: () => {},
  });
  const source = (name: string) => {
    const path = join(root, name);
    git(root, "init", "--initial-branch=main", path);
    git(path, "config", "user.name", "Chat test");
    git(path, "config", "user.email", "chat@example.test");
    writeFileSync(join(path, "README.md"), `${name}\n`);
    git(path, "add", "."); git(path, "commit", "-m", "initial");
    return { url: path, defaultBranch: "main" };
  };
  const task = (projectId: string, repos: any[] = []) => ({
    id: "task_first", workspaceId: "local", chatSessionId: "chat_test", issueId: null,
    chatProjectId: projectId, project: { id: projectId, workspaceId: "local" },
    projectResources: [], projectWikiDocs: [], repos, chatAutoCheckoutRepos: repos,
  });
  return { root, workDir, repoCache, daemon, source, task, resolved: { workDir, ensureDir: true, localDirectory: null } };
}

describe("bound Chat repository startup", () => {
  it("keeps a Runtime Workspace outside Project Chat checkout even with stale Project metadata", async () => {
    const f = fixture();
    const repo = f.source("project_repo");
    const task = { ...f.task("project_a", [repo]), runtimeWorkspaceId: "rws_local" };
    expect(f.daemon.canAutoCheckoutChatRepos(task, f.resolved)).toBe(false);
    const sync = spyOn(f.repoCache, "sync");
    const prepared = await f.daemon.prepareTaskWorkspace(task, f.resolved, [], signal());
    expect(prepared.checkouts).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
    expect(existsSync(join(f.workDir, "wiki"))).toBe(false);
    expect(existsSync(join(f.workDir, "project_repo"))).toBe(false);
  });

  it("fetches the first turn, then reuses one session branch and preserves edits without network", async () => {
    const f = fixture();
    const repo = f.source("first");
    const sync = spyOn(f.repoCache, "sync");
    const first = await f.daemon.prepareChatTaskWorkspace(f.task("project_a", [repo]), f.resolved, signal());
    expect(first.checkouts).toHaveLength(1);
    const checkout = first.checkouts[0];
    expect(checkout.branch).toBe("chat/chat_test");
    expect(git(checkout.path, "branch", "--show-current")).toBe("chat/chat_test");
    writeFileSync(join(checkout.path, "local.txt"), "keep my work");
    const originalHead = git(checkout.path, "rev-parse", "HEAD");
    writeFileSync(join(repo.url, "remote.txt"), "new upstream");
    git(repo.url, "add", "."); git(repo.url, "commit", "-m", "upstream advanced");
    f.daemon.workspaceRepoUrls.clear();
    const second = await f.daemon.prepareChatTaskWorkspace({ ...f.task("project_a", [repo]), id: "task_second", sessionId: "resumed" }, f.resolved, signal());
    expect(second.checkouts).toEqual(first.checkouts);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(git(checkout.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(readFileSync(join(checkout.path, "local.txt"), "utf8")).toBe("keep my work");
    expect(existsSync(join(checkout.path, "remote.txt"))).toBe(false);
  });

  it("never syncs the workspace fallback catalog when explicit Project repos are empty", async () => {
    const f = fixture();
    const sync = spyOn(f.repoCache, "sync");
    const fallback = f.source("workspace_fallback");
    const prepared = await f.daemon.prepareChatTaskWorkspace({ ...f.task("project_a"), repos: [fallback] }, f.resolved, signal());
    expect(sync).not.toHaveBeenCalled();
    expect(prepared.checkouts).toEqual([]);
  });

  it.each(["authentication failed", "network unreachable", "repository sync timed out"])("degrades %s to a repository warning", async (reason) => {
    const f = fixture();
    const repo = f.source("failed");
    spyOn(f.repoCache, "sync").mockRejectedValue(new Error(reason));
    const prepared = await f.daemon.prepareChatTaskWorkspace(f.task("project_a", [repo]), f.resolved, signal());
    expect(prepared.checkouts).toEqual([]);
    expect(prepared.repos[0].status).toBe("error");
    expect(prepared.warnings[0]).toMatchObject({ kind: "unavailable", message: reason });
  });

  it("bounds aggregate network time without aborting Chat, while honoring task cancellation", async () => {
    const f = fixture();
    const repo = f.source("slow");
    let stopped = false;
    spyOn(f.repoCache, "sync").mockImplementation(async (_workspace, _repos, options) => {
      return await new Promise((_, reject) => {
        options!.signal!.addEventListener("abort", () => { stopped = true; reject(options!.signal!.reason); }, { once: true });
      });
    });
    const taskAbort = new AbortController();
    const results = await f.daemon.syncColdChatRepos("local", [repo], taskAbort.signal, 5);
    expect(stopped).toBe(true);
    expect(taskAbort.signal.aborted).toBe(false);
    expect(results[0]).toMatchObject({ status: "failed", error: "Chat repository startup exceeded 5ms network budget" });
    const cancelled = f.daemon.syncColdChatRepos("local", [repo], taskAbort.signal, 1000);
    taskAbort.abort(new Error("task cancelled"));
    await expect(cancelled).rejects.toThrow("task cancelled");
  });

  it("uses a configurable 120 second total budget and rejects invalid overrides", () => {
    expect(chatRepoStartupBudgetMs({})).toBe(120_000);
    expect(chatRepoStartupBudgetMs({ MULTIREMI_REPO_CHAT_STARTUP_TIMEOUT_MS: "75000" })).toBe(75_000);
    for (const value of ["0", "-1", "invalid", "Infinity", "2147483648", "0.5"]) {
      expect(chatRepoStartupBudgetMs({ MULTIREMI_REPO_CHAT_STARTUP_TIMEOUT_MS: value })).toBe(120_000);
    }
  });

  it("preserves successful repositories when a later repository exhausts the shared budget", async () => {
    const f = fixture();
    const repos = [f.source("small"), f.source("large"), f.source("later")];
    const sync = spyOn(f.repoCache, "sync").mockImplementation(async (_workspace, selected, options) => {
      if (selected[0]!.url === repos[0]!.url) return [{ repoUrl: repos[0]!.url, status: "fresh", error: null }];
      return await new Promise((_, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      });
    });
    const results = await f.daemon.syncColdChatRepos("local", repos, signal(), 10);
    expect(results.map((result: any) => result.status)).toEqual(["fresh", "failed", "failed"]);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(results[1].error).toContain("10ms network budget");
    expect(results[2].error).toContain("10ms network budget");
  });

  it("preserves existing repositories without Git activity when the bound Project becomes unavailable", async () => {
    const f = fixture();
    const repo = f.source("existing");
    const first = await f.daemon.prepareChatTaskWorkspace(f.task("project_a", [repo]), f.resolved, signal());
    const repoPath = first.checkouts[0].path;
    writeFileSync(join(repoPath, "README.md"), "unsaved project change");
    const manifestPath = join(f.workDir, ".multiremi", "chat-repos.json");
    const previousManifest = readFileSync(manifestPath, "utf8");
    const sync = spyOn(f.repoCache, "sync");
    const checkout = spyOn(f.repoCache, "createWorktree");
    const unavailable = { ...f.task("project_a"), project: null };
    expect(f.daemon.canAutoCheckoutChatRepos(unavailable, f.resolved)).toBe(false);
    const next = await f.daemon.prepareTaskWorkspace(unavailable, f.resolved, [], signal());
    expect(next.checkouts).toEqual([]);
    expect(next.wikiMaterialized).toBe(false);
    expect(sync).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
    expect(readFileSync(join(repoPath, "README.md"), "utf8")).toBe("unsaved project change");
    expect(git(repoPath, "branch", "--show-current")).toBe("chat/chat_test");
    expect(readFileSync(manifestPath, "utf8")).toBe(previousManifest);
    expect(existsSync(join(f.workDir, ".multiremi", "wiki-archive"))).toBe(false);
  });

  it("requires bound Project identity, workspace ownership and daemon-owned directories", async () => {
    const f = fixture();
    const bound = f.task("project_a", [f.source("selected")]);
    expect(f.daemon.canAutoCheckoutChatRepos(bound, f.resolved)).toBe(true);
    const cases = [
      [ { ...bound, chatProjectId: null }, f.resolved ],
      [ { ...bound, chatProjectId: "wrong" }, f.resolved ],
      [ { ...bound, project: { ...bound.project, workspaceId: "foreign" } }, f.resolved ],
      [ bound, { ...f.resolved, ensureDir: false } ],
      [ bound, { ...f.resolved, localDirectory: { localPath: f.workDir } } ],
      [ { ...bound, workDir: f.root }, { ...f.resolved, workDir: f.root } ],
    ];
    const sync = spyOn(f.repoCache, "sync");
    const checkout = spyOn(f.repoCache, "createWorktree");
    for (const [task, resolved] of cases) {
      expect(f.daemon.canAutoCheckoutChatRepos(task, resolved)).toBe(false);
      expect((await f.daemon.autoCheckoutTaskRepos(task, resolved, [], signal())).checkouts).toEqual([]);
    }
    expect(sync).not.toHaveBeenCalled(); expect(checkout).not.toHaveBeenCalled();
  });
});
