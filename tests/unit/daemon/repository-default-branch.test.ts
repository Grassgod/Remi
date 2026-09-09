import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon repository default branches", () => {
  it.each(["workflow-dev", "missing"])("prepares an issue worktree with configured branch %s and reports its baseline", async (defaultBranch) => {
    const { daemon, repoUrl, workDir, reports, workflowCommit } = await fixture();
    const prepared = await daemon.autoCheckoutTaskRepos({
      id: "tsk_default", workspaceId: "local", issueId: "iss_default", runtimeId: "rt_default",
      issue: { key: "MUL-278" }, repos: [{ url: repoUrl, default_branch: defaultBranch }],
    }, { workDir, ensureDir: true, localDirectory: null }, [], new AbortController().signal);
    const expectedRef = `refs/remotes/origin/${defaultBranch === "missing" ? "main" : defaultBranch}`;
    expect(prepared.repos[0]).toMatchObject({ branchName: "agent/MUL-278", baseRef: expectedRef, status: "ready" });
    expect(reports.at(-1).repos[0]).toEqual(prepared.repos[0]);
    expect(reports.at(-1).status).toBe("in_use");
    expect(prepared.repos[0].baseCommit).toBe(git(prepared.repos[0].worktreePath, ["rev-parse", "HEAD"]));
    if (defaultBranch === "missing") {
      expect(prepared.warnings).toEqual([{
        repoUrl, kind: "default_branch_fallback",
        message: 'Configured default branch "missing" could not be resolved; fell back to refs/remotes/origin/main',
      }]);
    } else {
      expect(prepared.repos[0].baseCommit).toBe(workflowCommit);
      expect(prepared.warnings).toEqual([]);
    }
  });

  it("preserves stale-cache diagnostics when the preferred branch also falls back", async () => {
    const { daemon, repoUrl, workDir } = await fixture();
    const prepared = await daemon.autoCheckoutTaskRepos({
      id: "tsk_default", workspaceId: "local", issueId: "iss_default", issue: { key: "MUL-278" },
      repos: [{ url: repoUrl, defaultBranch: "missing" }],
    }, { workDir, ensureDir: true }, [{ repoUrl, status: "cached", error: "fetch timed out" }], new AbortController().signal);
    expect(prepared.warnings).toHaveLength(1);
    expect(prepared.warnings[0]).toMatchObject({ kind: "stale_cache", repoUrl });
    expect(prepared.warnings[0].message).toContain("fetch timed out");
    expect(prepared.warnings[0].message).toContain("fell back to refs/remotes/origin/main");
    expect(prepared.repos[0].status).toBe("ready");
  });

  it.each(["preferred_ref", "preferredRef"])("accepts soft %s through the local HTTP handler and keeps explicit ref strict", async (field) => {
    const { daemon, repoUrl, workDir, workflowCommit } = await fixture();
    const request = (ref?: string) => new Request("http://localhost/repo/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl, workspace_id: "local", workdir: workDir, [field]: "workflow-dev", ref }),
    });
    const response = await daemon.handleLocalDaemonRequest(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      base_ref: "refs/remotes/origin/workflow-dev", base_commit: workflowCommit, preferred_ref_resolved: true,
    });
    const failed = await daemon.handleLocalDaemonRequest(request("missing"));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain("cannot resolve requested ref");
  });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "daemon-default-branch-"));
  roots.push(root);
  const repoUrl = join(root, "source");
  git(root, ["init", "--initial-branch=main", repoUrl]);
  git(repoUrl, ["config", "user.name", "Branch Test"]);
  git(repoUrl, ["config", "user.email", "branch@example.test"]);
  writeFileSync(join(repoUrl, "README.md"), "main\n");
  git(repoUrl, ["add", "."]);
  git(repoUrl, ["commit", "-m", "main"]);
  git(repoUrl, ["checkout", "-b", "workflow-dev"]);
  writeFileSync(join(repoUrl, "README.md"), "workflow\n");
  git(repoUrl, ["commit", "-am", "workflow"]);
  const workflowCommit = git(repoUrl, ["rev-parse", "HEAD"]);
  git(repoUrl, ["checkout", "main"]);
  const repoCache = new MultiremiRepoCache(join(root, "cache"));
  await repoCache.sync("local", [{ url: repoUrl }]);
  const reports: any[] = [];
  const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
    repoCache, options: {}, terminalAuthorityMode: false,
    ensureRepoReady: async () => {}, assertWorkspaceRootOwner: () => {},
    workspaceCoAuthoredByEnabled: () => false,
    enqueueTaskReport: (_taskId: string, _kind: string, report: unknown) => reports.push(report),
  });
  return { daemon, repoUrl, workDir: join(root, "work"), reports, workflowCommit };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
