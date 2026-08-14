import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceGcOnce, type WorkspaceGcClient } from "@daemon/agent-runtime/workspace/gc.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Issue workspace GC", () => {
  it("cleans a v2 Issue root and reports the cleaned state", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-28", "iss_clean");
    mkdirSync(join(workspace, ".remi-runtime", "plugins", "abc"), { recursive: true });
    writeFileSync(join(workspace, ".remi-runtime", "plugins", "abc", "SKILL.md"), "# Plugin\n", { mode: 0o444 });
    const cleaned: string[] = [];
    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient({ cleaned }),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
    expect(cleaned).toEqual(["iss_clean"]);
  });

  it("keeps a completed Issue workspace when a repo has local changes", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-29", "iss_dirty");
    const repo = join(workspace, "remi");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "wip.txt"), "uncommitted\n");

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(workspace)).toBe(true);
  });

  it("keeps a clean completed Issue workspace when a commit is not pushed", async () => {
    const root = tempRoot();
    const remoteRoot = tempRoot();
    const workspace = issueWorkspace(root, "MUL-30", "iss_unpushed");
    const repo = join(workspace, "remi");
    const remote = join(remoteRoot, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "agent/MUL-30"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "tracked.txt"), "agent change\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "agent change"], { cwd: repo, stdio: "ignore" });

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(workspace)).toBe(true);
  });

  it("cleans read-only intake project views without sweeping shared snapshots", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-44", "iss_intake");
    const project = join(workspace, "projects", "Remi");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "project.json"), "{}\n", { mode: 0o444 });
    chmodSync(project, 0o555);
    chmodSync(join(workspace, "projects"), 0o555);
    const snapshot = join(root, ".snapshots", "local", "repo", "abc123");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "README.md"), "shared\n");

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(join(snapshot, "README.md"))).toBe(true);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-issue-gc-"));
  roots.push(root);
  return root;
}

function issueWorkspace(root: string, key: string, issueId: string): string {
  const workspace = join(root, key);
  mkdirSync(join(workspace, ".multiremi"), { recursive: true });
  writeFileSync(join(workspace, ".multiremi", "gc.json"), JSON.stringify({
    version: 2,
    kind: "issue",
    issue_id: issueId,
    task_id: `tsk_${issueId}`,
  }));
  return workspace;
}

function gcClient(options: { cleaned?: string[] } = {}): WorkspaceGcClient {
  return {
    getIssueGcCheck: async () => ({ status: "done", updated_at: "2000-01-01T00:00:00.000Z" }),
    getChatSessionGcCheck: async () => ({ status: "active" }),
    getAutopilotRunGcCheck: async () => ({ status: "running" }),
    getTaskGcCheck: async () => ({ status: "running" }),
    reportIssueWorkspaceCleaned: async (issueId) => { options.cleaned?.push(issueId); },
  };
}
