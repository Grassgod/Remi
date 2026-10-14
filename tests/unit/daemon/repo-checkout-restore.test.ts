import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import { ReclaimEngine } from "@daemon/agent-runtime/workspace/reclaim.js";
import { upsertSubjectRecord, readSubjectRecord, writeSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";
import { STORAGE_SETTINGS_DEFAULTS } from "@multiremi/contracts/storage.js";
import { laneWorkDirectory, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("a reclaimed Chat checking its repository out again on demand", () => {
  test("gets its unsaved work back through the local checkout endpoint", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "daemon-checkout-restore-")));
    roots.push(scratch);
    const root = join(scratch, "workspaces");
    const repoUrl = join(scratch, "source");
    git(scratch, ["init", "--initial-branch=main", repoUrl]);
    git(repoUrl, ["config", "user.name", "Test"]);
    git(repoUrl, ["config", "user.email", "test@example.test"]);
    writeFileSync(join(repoUrl, "README.md"), "main\n");
    git(repoUrl, ["add", "."]);
    git(repoUrl, ["commit", "-m", "main"]);
    const repoCache = new MultiremiRepoCache(join(root, "shared", "repos"));
    await repoCache.sync("local", [{ url: repoUrl }]);

    // The Chat worked in a worktree, left unsaved changes, and was reclaimed.
    const subject = { kind: "chat" as const, id: "chat_1" };
    const workDir = workDirectory(root, subject);
    const first = await repoCache.createWorktree({
      workspaceId: "local", repoUrl, workDir, agentName: "agent", taskId: "tsk_1", branchName: "chat/chat_1", skipFetch: true,
    });
    writeFileSync(join(first.path, "README.md"), "edited by the chat\n");
    writeFileSync(join(first.path, "notes.txt"), "notes\n");
    upsertSubjectRecord(root, { subject, workspace_id: "local" });
    const aged = { ...readSubjectRecord(root, subject)!, last_used_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() };
    writeSubjectRecord(root, aged);
    const locker = new IssueWorkspaceLifecycleLocker();
    const engine = new ReclaimEngine({
      root,
      client: {
        getIssueGcCheck: async () => { throw new Error("unused"); },
        getChatSessionGcCheck: async () => ({ status: "archived", updated_at: aged.last_used_at, pinned: false, origin: null }),
        getTaskGcCheck: async () => { throw new Error("unused"); },
        reportSubjectReclaimed: async () => {},
      },
      runtimeId: () => "rt_1",
      policyFor: () => STORAGE_SETTINGS_DEFAULTS,
      dryRun: false,
      legacyKeepDays: 7,
      locker,
      measure: async () => 0,
    });
    await engine.run("periodic");
    expect(existsSync(workDir)).toBe(false);
    expect(readSubjectRecord(root, subject)!.state).toBe("reclaimed");

    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      repoCache,
      options: { workspacesRoot: root },
      issueWorkspaceLifecycleLocks: locker,
      terminalAuthorityMode: false,
      ensureRepoReady: async () => {},
      assertWorkspaceRootOwner: () => {},
      workspaceCoAuthoredByEnabled: () => false,
    });
    const response = await daemon.handleLocalDaemonRequest(new Request("http://localhost/repo/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl, workspace_id: "local", workdir: workDir }),
    }));
    expect(response.status).toBe(200);
    const { path } = await response.json() as { path: string };

    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("edited by the chat\n");
    expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("notes\n");
    expect(readSubjectRecord(root, subject)!.state).toBe("active");
  });

  for (const kind of ["chat", "issue"] as const) {
    test(`a ${kind} checking out again after the remote base moved gets its unsaved work back`, async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "daemon-checkout-moved-")));
      roots.push(scratch);
      const root = join(scratch, "workspaces");
      const repoUrl = join(scratch, "source");
      git(scratch, ["init", "--initial-branch=main", repoUrl]);
      git(repoUrl, ["config", "user.name", "Test"]);
      git(repoUrl, ["config", "user.email", "test@example.test"]);
      writeFileSync(join(repoUrl, "README.md"), "main\n");
      git(repoUrl, ["add", "."]);
      git(repoUrl, ["commit", "-m", "main"]);
      const repoCache = new MultiremiRepoCache(join(root, "shared", "repos"));
      await repoCache.sync("local", [{ url: repoUrl }]);
      const subject = { kind, id: `${kind}_1` };
      const workDir = workDirectory(root, subject);
      const locker = new IssueWorkspaceLifecycleLocker();
      const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
        repoCache,
        options: { workspacesRoot: root },
        issueWorkspaceLifecycleLocks: locker,
        terminalAuthorityMode: false,
        ensureRepoReady: async () => {},
        assertWorkspaceRootOwner: () => {},
        workspaceCoAuthoredByEnabled: () => false,
      });
      const checkout = async (taskId: string) => {
        const response = await daemon.handleLocalDaemonRequest(new Request("http://localhost/repo/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: repoUrl, workspace_id: "local", workdir: workDir, agent_name: "agent", task_id: taskId }),
        }));
        expect(response.status).toBe(200);
        return (await response.json() as { path: string; branch_name: string });
      };

      upsertSubjectRecord(root, { subject, workspace_id: "local", issue_key: kind === "issue" ? "REM-7" : null });
      const first = await checkout("tsk_1");
      expect(first.branch_name).toBe(kind === "chat" ? "chat/chat_1" : "agent/REM-7");
      writeFileSync(join(first.path, "README.md"), "edited on demand\n");

      const aged = { ...readSubjectRecord(root, subject)!, last_used_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() };
      writeSubjectRecord(root, aged);
      const engine = new ReclaimEngine({
        root,
        client: {
          getIssueGcCheck: async () => ({ status: "done", updated_at: aged.last_used_at }),
          getChatSessionGcCheck: async () => ({ status: "archived", updated_at: aged.last_used_at, pinned: false, origin: null }),
          getTaskGcCheck: async () => { throw new Error("unused"); },
          reportSubjectReclaimed: async () => {},
        },
        runtimeId: () => "rt_1",
        policyFor: () => STORAGE_SETTINGS_DEFAULTS,
        dryRun: false,
        legacyKeepDays: 7,
        locker,
        measure: async () => 0,
      });
      await engine.run("periodic");
      expect(readSubjectRecord(root, subject)!.state).toBe("reclaimed");

      writeFileSync(join(repoUrl, "other.txt"), "the base moved\n");
      git(repoUrl, ["add", "."]);
      git(repoUrl, ["commit", "-m", "base moves"]);

      const second = await checkout("tsk_2");
      expect(second.branch_name).toBe(first.branch_name);
      expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("edited on demand\n");
      expect(readSubjectRecord(root, subject)!.state).toBe("active");
    });
  }

  test("a checkout outside a subject's work directory restores nothing", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "daemon-checkout-elsewhere-")));
    roots.push(scratch);
    mkdirSync(join(scratch, "elsewhere"), { recursive: true });
    const repoUrl = join(scratch, "source");
    git(scratch, ["init", "--initial-branch=main", repoUrl]);
    git(repoUrl, ["config", "user.name", "Test"]);
    git(repoUrl, ["config", "user.email", "test@example.test"]);
    writeFileSync(join(repoUrl, "README.md"), "main\n");
    git(repoUrl, ["add", "."]);
    git(repoUrl, ["commit", "-m", "main"]);
    const repoCache = new MultiremiRepoCache(join(scratch, "cache"));
    await repoCache.sync("local", [{ url: repoUrl }]);
    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      repoCache,
      options: { workspacesRoot: join(scratch, "workspaces") },
      issueWorkspaceLifecycleLocks: new IssueWorkspaceLifecycleLocker(),
      terminalAuthorityMode: false,
      ensureRepoReady: async () => {},
      assertWorkspaceRootOwner: () => {},
      workspaceCoAuthoredByEnabled: () => false,
    });

    const response = await daemon.handleLocalDaemonRequest(new Request("http://localhost/repo/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl, workspace_id: "local", workdir: join(scratch, "elsewhere") }),
    }));

    expect(response.status).toBe(200);
  });

  test("refuses a checkout from a private execution directory: nothing restores a repository there", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "daemon-checkout-private-")));
    roots.push(scratch);
    const root = join(scratch, "workspaces");
    const lane = laneWorkDirectory(root, {
      subject: { kind: "issue", id: "iss_1" }, conversation: "ises_1", agentId: "agt_1", scope: null, generation: 1,
    });
    mkdirSync(lane, { recursive: true });
    let prepared = 0;
    const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
      options: { workspacesRoot: root },
      issueWorkspaceLifecycleLocks: new IssueWorkspaceLifecycleLocker(),
      terminalAuthorityMode: false,
      ensureRepoReady: async () => { prepared++; },
      assertWorkspaceRootOwner: () => {},
    });

    const response = await daemon.handleLocalDaemonRequest(new Request("http://localhost/repo/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.test/repo.git", workspace_id: "local", workdir: lane }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("$MULTIREMI_WORKSPACE_ROOT") });
    expect(prepared).toBe(0);
  });
});

describe("the agent's own files in a checkout", () => {
  /** A repository may commit its own agent files, at the root or deeper; an agent is often asked to add them. */
  const FILES = ["CLAUDE.md", "AGENTS.md", join(".claude", "skills", "x", "SKILL.md"), join(".opencode", "agent.json"), join("frontend", "AGENTS.md"), join("packages", "api", "CLAUDE.md")];

  function writeFiles(worktree: string, files: string[]): void {
    for (const file of files) {
      mkdirSync(join(worktree, file, ".."), { recursive: true });
      writeFileSync(join(worktree, file), "content\n");
    }
  }

  async function cacheOf(tag: string) {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), `daemon-agent-files-${tag}-`)));
    roots.push(scratch);
    const root = join(scratch, "workspaces");
    const repoUrl = join(scratch, "source");
    git(scratch, ["init", "--initial-branch=main", repoUrl]);
    git(repoUrl, ["config", "user.name", "Test"]);
    git(repoUrl, ["config", "user.email", "test@example.test"]);
    writeFileSync(join(repoUrl, "README.md"), "main\n");
    git(repoUrl, ["add", "."]);
    git(repoUrl, ["commit", "-m", "main"]);
    const repoCache = new MultiremiRepoCache(join(root, "shared", "repos"));
    await repoCache.sync("local", [{ url: repoUrl }]);
    const checkout = (subject: { kind: "issue" | "chat"; id: string }, branchName: string) => repoCache.createWorktree({
      workspaceId: "local", repoUrl, workDir: workDirectory(root, subject), agentName: "agent", taskId: "tsk_1", branchName, skipFetch: true, reuseExisting: true,
    });
    return { root, checkout };
  }

  /** A round at which the Issue, last used a month ago, has long ended. */
  async function endedIssueRound(root: string, subject: { kind: "issue"; id: string }) {
    upsertSubjectRecord(root, { subject, workspace_id: "local", issue_key: "MUL-1" });
    const aged = { ...readSubjectRecord(root, subject)!, last_used_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() };
    writeSubjectRecord(root, aged);
    const engine = new ReclaimEngine({
      root,
      client: {
        getIssueGcCheck: async () => ({ status: "done", updated_at: aged.last_used_at }),
        getChatSessionGcCheck: async () => { throw new Error("unused"); },
        getTaskGcCheck: async () => { throw new Error("unused"); },
        reportSubjectReclaimed: async () => {},
      },
      runtimeId: () => "rt_1",
      policyFor: () => STORAGE_SETTINGS_DEFAULTS,
      dryRun: false,
      legacyKeepDays: 7,
      locker: new IssueWorkspaceLifecycleLocker(),
      measure: async () => 0,
    });
    return await engine.run("periodic");
  }

  test("are work: they show in git status and the snapshot saves them when the ended Issue is reclaimed", async () => {
    const { root, checkout } = await cacheOf("snapshot");
    const subject = { kind: "issue" as const, id: "iss_1" };
    const first = await checkout(subject, "agent/MUL-1");
    writeFiles(first.path, FILES);
    expect(git(first.path, ["status", "--porcelain", "--untracked-files=all"]).split("\n").sort()).toEqual(FILES.map((file) => `?? ${file}`).sort());
    const bare = resolve(first.path, git(first.path, ["rev-parse", "--git-common-dir"]));

    const report = await endedIssueRound(root, subject);

    expect(report.plan).toEqual([expect.objectContaining({ action: "reclaim", unsaved_work: true })]);
    const [saved] = readSubjectRecord(root, subject)!.snapshot!.git;
    expect(git(bare, ["ls-tree", "-r", "--name-only", saved!.commit]).split("\n").sort()).toEqual(["README.md", ...FILES].sort());
  });
});
