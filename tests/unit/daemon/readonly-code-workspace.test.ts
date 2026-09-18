import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiRepoCache } from "@daemon/agent-runtime/repo/checkout.js";
import { prepareReadOnlyCodeWorkspace } from "@daemon/agent-runtime/workspace/readonly-code.js";
import { runWorkspaceGcOnce } from "@daemon/agent-runtime/workspace/gc.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("discussion code snapshots", () => {
  it("dispatches opt-in preparation from the daemon and freezes local committed HEAD without syncing", async () => {
    const f = await fixture();
    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      repoCache: f.cache,
      autoCheckoutTaskRepos: () => { throw new Error("must not prepare an ordinary checkout"); },
      enqueueTaskReport: () => { throw new Error("must not register a shared Issue workspace"); },
    });
    const prepared = await daemon.prepareTaskWorkspace(f.task, {
      workDir: f.workDir, ensureDir: true, localDirectory: false,
    }, [], new AbortController().signal);
    expect(prepared.checkouts).toEqual([]);
    expect(prepared.repos).toEqual([]);
    expect(prepared.snapshots).toEqual([{ repoUrl: f.source, path: join(f.workDir, "source"), commit: f.parentCommit }]);
    const snapshotPath = prepared.snapshots[0].path;
    expect(readFileSync(join(snapshotPath, "README.md"), "utf8")).toBe("parent committed\n");
    expect(git(snapshotPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
    expect(git(snapshotPath, ["log", "-1", "--format=%s"])).toBe("parent committed");
    expect(JSON.parse(readFileSync(join(f.workDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
      kind: "discussion_issue", issue_id: "issue", issue_session_id: "side",
    });
    writeFileSync(join(f.parentPath, "README.md"), "later parent commit\n");
    git(f.parentPath, ["commit", "-am", "later"]);
    const next = await prepareReadOnlyCodeWorkspace(f.workDir, f.task, f.cache);
    expect(next.snapshots).toEqual(prepared.snapshots);
    expect(readFileSync(join(snapshotPath, "README.md"), "utf8")).toBe("parent committed\n");
  });

  it("keeps default discussions repository-free", async () => {
    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      repoCache: { createWorktree: () => { throw new Error("default discussion must not checkout"); } },
    });
    expect(await daemon.prepareTaskWorkspace({ holdsWorkspace: false, repos: [] }, {
      workDir: "/unused", ensureDir: true, localDirectory: false,
    }, [], new AbortController().signal)).toEqual({ checkouts: [], repos: [], warnings: [] });
  });

  it("fails without a local parent branch or cache instead of using origin or cloning", async () => {
    const f = await fixture();
    git(f.parentPath, ["checkout", "--detach"]);
    git(f.parentPath, ["branch", "-D", "agent/MUL-324"]);
    expect(git(f.cache.lookup("local", f.source)!, ["rev-parse", "refs/remotes/origin/agent/MUL-324"])).toBeTruthy();
    await expect(prepareReadOnlyCodeWorkspace(f.workDir, f.task, f.cache)).rejects.toThrow();
    await expect(prepareReadOnlyCodeWorkspace(f.workDir, {
      ...f.task, repos: [{ url: join(f.root, "missing") }],
    }, f.cache)).rejects.toThrow("Parent repository is not available");
    expect(existsSync(join(f.workDir, "source"))).toBe(false);
  });

  it("requires an inherited discussion Session before touching the filesystem", async () => {
    const f = await fixture();
    for (const task of [
      { ...f.task, holdsWorkspace: true },
      { ...f.task, issueSession: { ...f.task.issueSession!, parentSessionId: null } },
      { ...f.task, issueSession: { ...f.task.issueSession!, withCode: false } },
      { ...f.task, chatSessionId: "private-chat" },
    ]) {
      await expect(prepareReadOnlyCodeWorkspace(f.workDir, task, f.cache)).rejects.toThrow("inherited discussion Session");
    }
    expect(existsSync(f.workDir)).toBe(false);
  });

  it("refuses symlinked discussion roots and metadata before writing GC state", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    mkdirSync(join(f.workspacesRoot, "discussions", "MUL-324"), { recursive: true });
    symlinkSync(outside, f.workDir, "dir");
    await expect(prepareReadOnlyCodeWorkspace(f.workDir, f.task, f.cache)).rejects.toThrow("Unsafe read-only discussion workspace");
    expect(existsSync(join(outside, ".multiremi"))).toBe(false);
    rmSync(f.workDir);
    mkdirSync(f.workDir);
    symlinkSync(outside, join(f.workDir, ".multiremi"), "dir");
    await expect(prepareReadOnlyCodeWorkspace(f.workDir, f.task, f.cache)).rejects.toThrow("Unsafe read-only discussion workspace");
    expect(existsSync(join(outside, "gc.json"))).toBe(false);
  });

  it("retains active snapshots and deletes terminal snapshots through existing discussion GC", async () => {
    const f = await fixture();
    await prepareReadOnlyCodeWorkspace(f.workDir, f.task, f.cache);
    let status = "in_progress";
    const gcOptions = {
      root: f.workspacesRoot, ttlMs: 0, orphanTtlMs: 0, now: Date.now() + 1_000,
      client: {
        getIssueGcCheck: async () => ({ status, updated_at: "2000-01-01T00:00:00.000Z" }),
        getChatSessionGcCheck: async () => { throw new Error("unexpected Chat GC"); },
        getAutopilotRunGcCheck: async () => { throw new Error("unexpected Autopilot GC"); },
        getTaskGcCheck: async () => { throw new Error("unexpected Task GC"); },
        reportIssueWorkspaceCleaned: async () => { throw new Error("must not report the parent workspace cleaned"); },
      },
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => { throw new Error("must not archive a discussion snapshot"); },
      hasDirtyGitWorktree: async () => { throw new Error("must not inspect detached snapshot dirtiness"); },
    };
    expect(await runWorkspaceGcOnce(gcOptions)).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    status = "done";
    expect(await runWorkspaceGcOnce(gcOptions)).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(f.workDir)).toBe(false);
    expect(existsSync(f.parentPath)).toBe(true);
  });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "readonly-code-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.name", "Snapshot Test"]);
  git(source, ["config", "user.email", "snapshot@example.test"]);
  writeFileSync(join(source, "README.md"), "remote\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "remote"]);
  git(source, ["branch", "agent/MUL-324"]);
  const cache = new MultiremiRepoCache(join(root, "cache"));
  await cache.sync("local", [{ url: source }]);
  const parent = await cache.createWorktree({
    workspaceId: "local", repoUrl: source, workDir: join(root, "parent"),
    branchName: "agent/MUL-324", skipFetch: true, coAuthoredByEnabled: false,
  });
  git(parent.path, ["config", "user.name", "Snapshot Test"]);
  git(parent.path, ["config", "user.email", "snapshot@example.test"]);
  writeFileSync(join(parent.path, "README.md"), "parent committed\n");
  git(parent.path, ["commit", "-am", "parent committed"]);
  const parentCommit = git(parent.path, ["rev-parse", "HEAD"]);
  writeFileSync(join(parent.path, "README.md"), "parent uncommitted\n");
  const workspacesRoot = join(root, "workspaces");
  const workDir = join(workspacesRoot, "discussions", "MUL-324", "side");
  const task = {
    id: "task", workspaceId: "local", issueId: "issue", issueSessionId: "side",
    holdsWorkspace: false, issue: { id: "issue", key: "MUL-324" },
    issueSession: { id: "side", title: "Side", parentSessionId: "parent", inheritMode: "follow", withCode: true },
    repos: [{ url: source }],
  } as AgentTask;
  return { root, source, cache, parentPath: parent.path, parentCommit, workspacesRoot, workDir, task };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
