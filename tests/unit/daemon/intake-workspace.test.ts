import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";
import { prepareIntakeWorkspace } from "@daemon/agent-runtime/workspace/intake.js";
import type { AgentTask } from "@daemon/contracts/types.js";

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

describe("intake workspace", () => {
  it("materializes project-scoped knowledge and links immutable repo snapshots", async () => {
    const source = createRepo();
    const sameNameSource = createRepo();
    const cache = new MultiremiRepoCache(tempDir("intake-cache-"));
    await cache.sync("local", [{ url: source }, { url: sameNameSource }]);
    const workDir = tempDir("intake-workspace-");
    const snapshotsRoot = tempDir("intake-snapshots-");
    const task = {
      id: "tsk_intake",
      workspaceId: "local",
      issueId: "iss_intake",
      issue: { id: "iss_intake", key: "MUL-44", title: "Triage request" },
      projectContexts: [{
        project: { id: "prj_remi", title: "Remi", description: "Remi project" },
        resources: [],
        docs: [
          { id: "doc_wiki", kind: "wiki", slug: "architecture", title: "Architecture", summary: null, body: "# Architecture\n\nUse Bun.", tags: [], pinned: false, updatedAt: "2026-08-15T00:00:00.000Z" },
          { id: "doc_memory", kind: "memory", slug: "release-rule", title: "Release rule", summary: null, body: "Tags are immutable.", tags: [], pinned: true, updatedAt: "2026-08-15T00:00:00.000Z" },
        ],
        repos: [{ url: source }, { url: sameNameSource }],
      }],
    } as unknown as AgentTask;

    const prepared = await prepareIntakeWorkspace(workDir, task, cache, { snapshotsRoot });

    const projectRoot = join(workDir, "projects", "Remi");
    const repoLink = join(projectRoot, "repos", "repo");
    expect(prepared.repos).toHaveLength(2);
    expect(prepared.repos[0]).toMatchObject({ branchName: "", status: "ready", dirty: false });
    expect(readdirSync(join(projectRoot, "repos")).sort()).toEqual([
      "repo",
      expect.stringMatching(/^repo-[a-f0-9]{8}$/),
    ]);
    expect(lstatSync(repoLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(repoLink, "README.md"), "utf8")).toBe("intake snapshot\n");
    expect(existsSync(join(repoLink, ".git"))).toBe(false);
    expect(readFileSync(join(projectRoot, "knowledge", "wiki", "architecture.md"), "utf8")).toContain("Use Bun.");
    expect(readFileSync(join(projectRoot, "knowledge", "memory", "release-rule.md"), "utf8")).toBe("Tags are immutable.\n");
    expect(JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"))).toMatchObject({
      mode: "intake",
      issue_key: "MUL-44",
      projects: [{ id: "prj_remi", directory: "Remi" }],
    });
    expect(JSON.parse(readFileSync(join(workDir, ".multiremi", "workspace.json"), "utf8"))).toMatchObject({
      kind: "intake",
      read_only: true,
    });
  });

  it("degrades a repo without a usable snapshot to an error entry instead of failing the round", async () => {
    const source = createRepo();
    const cache = new MultiremiRepoCache(tempDir("intake-cache-"));
    await cache.sync("local", [{ url: source }]);
    const workDir = tempDir("intake-workspace-");
    const snapshotsRoot = tempDir("intake-snapshots-");
    const missing = join(tempDir("intake-missing-"), "gone.git");
    const task = {
      id: "tsk_intake_degraded",
      workspaceId: "local",
      issueId: "iss_intake",
      issue: { id: "iss_intake", key: "MUL-75", title: "Triage request" },
      projectContexts: [{
        project: { id: "prj_remi", title: "Remi", description: "Remi project" },
        resources: [],
        docs: [],
        repos: [{ url: source }, { url: missing }],
      }],
    } as unknown as AgentTask;

    const prepared = await prepareIntakeWorkspace(workDir, task, cache, { snapshotsRoot, skipRepoFetch: true });

    expect(prepared.repos).toHaveLength(2);
    const ready = prepared.repos.find((repo) => repo.repoUrl === source);
    const failed = prepared.repos.find((repo) => repo.repoUrl === missing);
    expect(ready).toMatchObject({ status: "ready", error: null });
    expect(failed).toMatchObject({ status: "error", baseRef: "" });
    expect(failed?.error).toContain("repo not found in cache");
    const projectRoot = join(workDir, "projects", "Remi");
    expect(readdirSync(join(projectRoot, "repos"))).toEqual(["repo"]);
    const manifest = JSON.parse(readFileSync(join(workDir, "manifest.json"), "utf8"));
    expect(manifest.projects[0].repos).toHaveLength(1);
    expect(manifest.projects[0].repos[0].url).toBe(source);
  });
});

function createRepo(): string {
  const dir = join(tempDir("intake-source-"), "repo");
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main", dir], { env: gitEnv(), stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "intake@example.test"], { cwd: dir, env: gitEnv(), stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Intake Test"], { cwd: dir, env: gitEnv(), stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "intake snapshot\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, env: gitEnv(), stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, env: gitEnv(), stdio: "pipe" });
  return dir;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}
