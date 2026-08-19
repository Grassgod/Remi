import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceGcOnce, type WorkspaceGcClient } from "@daemon/agent-runtime/workspace/gc.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Issue workspace GC", () => {
  it("holds the Issue lifecycle lock through archive verification and removal", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-locked", "iss_locked");
    let lockHeld = false;
    let lockReleasedAfterRemoval = false;

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      requireIssueSessionArchive: true,
      withIssueWorkspaceLock: async (issueId, workspaceDir, action) => {
        expect(issueId).toBe("iss_locked");
        expect(workspaceDir).toBe(workspace);
        lockHeld = true;
        await action();
        lockReleasedAfterRemoval = !existsSync(workspace);
        lockHeld = false;
      },
      ensureIssueSessionArchive: async () => {
        expect(lockHeld).toBe(true);
        return archiveBinding();
      },
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(lockHeld).toBe(false);
    expect(lockReleasedAfterRemoval).toBe(true);
  });

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
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archiveBinding(),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
    expect(cleaned).toEqual(["iss_clean"]);
  });

  it("replays a durable cleaned-state receipt after a transient report failure", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-28-retry", "iss_clean_retry");
    const cleaned: string[] = [];
    let fail = true;
    const client = gcClient();
    client.reportIssueWorkspaceCleaned = async (issueId) => {
      if (fail) throw new Error("server unavailable");
      expect(readdirSync(join(root, ".multiremi-delete-quarantine"))).toHaveLength(0);
      cleaned.push(issueId);
    };
    const errors: string[] = [];

    const first = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archiveBinding(),
      onError: (path, error) => errors.push(`${path}:${error instanceof Error ? error.message : error}`),
      now: Date.now() + 1_000,
    });
    expect(first).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
    expect(errors[0]).toContain("server unavailable");
    expect(readdirSync(join(root, ".gc-cleaned-outbox"))).toHaveLength(1);
    const receiptPath = join(
      root,
      ".gc-cleaned-outbox",
      readdirSync(join(root, ".gc-cleaned-outbox"))[0]!,
    );
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      version: 2,
      issue_id: "iss_clean_retry",
      runtime_id: "rt_1",
      archive_id: "sar_ready",
      source_revision: "a".repeat(64),
      sha256: "b".repeat(64),
    });
    // Model a crash after rename but before recursive removal. Recovery must
    // delete retained bytes before replaying the control-plane receipt.
    const crashedGeneration = join(
      root,
      ".multiremi-delete-quarantine",
      `MUL-28-retry.${process.pid}.${randomUUID()}.deleting`,
    );
    mkdirSync(crashedGeneration);
    writeFileSync(join(crashedGeneration, "retained-session.jsonl"), "must be removed\n");

    fail = false;
    expect(await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archiveBinding(),
    })).toEqual({ cleaned: 0, orphaned: 0, skipped: 0 });
    expect(cleaned).toEqual(["iss_clean_retry"]);
    expect(readdirSync(join(root, ".gc-cleaned-outbox"))).toHaveLength(0);
  });

  it("does not discard a cleaned receipt for an ownership 404", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-ownership-retry", "iss_ownership_retry");
    const client = gcClient();
    client.reportIssueWorkspaceCleaned = async () => {
      throw Object.assign(new Error("HTTP 404 runtime mismatch"), {
        code: "issue_workspace_runtime_mismatch",
      });
    };
    await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archiveBinding(),
      now: Date.now() + 1_000,
    });
    expect(readdirSync(join(root, ".gc-cleaned-outbox"))).toHaveLength(1);

    await runWorkspaceGcOnce({ root, ttlMs: 0, orphanTtlMs: 0, runtimeId: "rt_1", client });
    expect(readdirSync(join(root, ".gc-cleaned-outbox"))).toHaveLength(1);

    client.reportIssueWorkspaceCleaned = async () => {
      throw Object.assign(new Error("HTTP 404 issue missing"), { code: "issue_not_found" });
    };
    await runWorkspaceGcOnce({ root, ttlMs: 0, orphanTtlMs: 0, runtimeId: "rt_1", client });
    expect(readdirSync(join(root, ".gc-cleaned-outbox"))).toHaveLength(0);
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

  it("requires a verified Session archive before deleting an Issue workspace", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-31", "iss_archive");
    const attempts: string[] = [];

    const blocked = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async (issueId, workspaceDir, forceFreshSnapshot) => {
        attempts.push(`${issueId}:${workspaceDir}:${forceFreshSnapshot}`);
        return null;
      },
      now: Date.now() + 1_000,
    });

    expect(blocked).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(workspace)).toBe(true);
    expect(attempts).toEqual([`iss_archive:${workspace}:true`]);

    const cleaned = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archiveBinding(),
      now: Date.now() + 1_000,
    });
    expect(cleaned).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
  });

  it("fails closed when a missing Issue still has provider Session state", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-missing-history", "iss_missing_history");
    const history = join(
      workspace,
      ".multiremi",
      "sessions",
      "ises_1",
      "agt_1",
      "1",
      "home",
      "projects",
      "history.jsonl",
    );
    mkdirSync(join(history, ".."), { recursive: true });
    writeFileSync(history, "{\"type\":\"message\"}\n");
    const errors: string[] = [];
    const client = gcClient();
    client.getIssueGcCheck = async () => { throw new Error("404 issue not found"); };

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client,
      onError: (_path, error) => errors.push(error instanceof Error ? error.message : String(error)),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(workspace)).toBe(true);
    expect(errors).toEqual([
      "Issue iss_missing_history is missing from the server while provider Session state remains; refusing orphan cleanup",
    ]);
  });

  for (const metadata of ["missing", "corrupt"] as const) {
    it(`fails closed when GC metadata is ${metadata} but provider Session state remains`, async () => {
      const root = tempRoot();
      const workspace = issueWorkspace(root, `MUL-${metadata}-metadata`, `iss_${metadata}_metadata`);
      const gcPath = join(workspace, ".multiremi", "gc.json");
      if (metadata === "missing") rmSync(gcPath);
      else writeFileSync(gcPath, "{not-json\n");
      const history = join(
        workspace,
        ".multiremi",
        "sessions",
        "ises_1",
        "agt_1",
        "1",
        "home",
        "projects",
        "history.jsonl",
      );
      mkdirSync(join(history, ".."), { recursive: true });
      writeFileSync(history, "{\"type\":\"message\"}\n");
      const errors: string[] = [];

      const result = await runWorkspaceGcOnce({
        root,
        ttlMs: 0,
        orphanTtlMs: 0,
        client: gcClient(),
        onError: (_path, error) => errors.push(error instanceof Error ? error.message : String(error)),
        now: Date.now() + 1_000,
      });

      expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(history)).toBe(true);
      expect(errors).toEqual([
        `Workspace ${workspace} has provider Session state but no valid GC metadata; refusing orphan cleanup`,
      ]);
    });
  }

  it("keeps the legacy orphan TTL behavior for a missing Issue without Session state", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-missing-empty", "iss_missing_empty");
    const client = gcClient();
    client.getIssueGcCheck = async () => { throw new Error("404 issue not found"); };

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client,
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 1, skipped: 0 });
    expect(existsSync(workspace)).toBe(false);
  });

  it("forces a fresh archive only on the sweep that can delete the workspace", async () => {
    const root = tempRoot();
    const workspace = issueWorkspace(root, "MUL-archive-fresh", "iss_archive_fresh");
    const freshness: boolean[] = [];

    const retained = await runWorkspaceGcOnce({
      root,
      ttlMs: 72 * 60 * 60 * 1_000,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async (_issueId, _workspaceDir, forceFreshSnapshot) => {
        freshness.push(forceFreshSnapshot);
        return archiveBinding();
      },
      now: new Date("2000-01-01T01:00:00.000Z").getTime(),
    });
    expect(retained).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(freshness).toEqual([false]);
    expect(existsSync(workspace)).toBe(true);

    const cleaned = await runWorkspaceGcOnce({
      root,
      ttlMs: 72 * 60 * 60 * 1_000,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client: gcClient(),
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async (_issueId, _workspaceDir, forceFreshSnapshot) => {
        freshness.push(forceFreshSnapshot);
        return archiveBinding();
      },
      now: new Date("2000-01-05T00:00:00.000Z").getTime(),
    });
    expect(cleaned).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(freshness).toEqual([false, true]);
    expect(existsSync(workspace)).toBe(false);
  });

  it("keeps a local-directory Issue sidecar while active and archives it when terminal", async () => {
    const root = tempRoot();
    const sidecar = issueWorkspace(join(root, ".issue-runtime"), "iss_local", "iss_local");
    const archiveAttempts: string[] = [];
    const client = gcClient();
    client.getIssueGcCheck = async () => ({ status: "active", updated_at: "2000-01-01T00:00:00.000Z" });

    expect(await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => {
        archiveAttempts.push("unexpected");
        return archiveBinding();
      },
      now: Date.now() + 1_000,
    })).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(sidecar)).toBe(true);
    expect(archiveAttempts).toEqual([]);

    client.getIssueGcCheck = async () => ({ status: "done", updated_at: "2000-01-01T00:00:00.000Z" });
    expect(await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async (issueId, workspaceDir, forceFresh) => {
        archiveAttempts.push(`${issueId}:${workspaceDir}:${forceFresh}`);
        return archiveBinding();
      },
      now: Date.now() + 1_000,
    })).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
    expect(archiveAttempts).toEqual([`iss_local:${sidecar}:true`]);
    expect(existsSync(sidecar)).toBe(false);
  });

  it("isolates archive failures so another eligible workspace is still collected", async () => {
    const root = tempRoot();
    const failed = issueWorkspace(root, "MUL-32", "iss_failed");
    const ready = issueWorkspace(root, "MUL-33", "iss_ready");
    const errors: string[] = [];
    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client: gcClient(),
      requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async (issueId) => {
        if (issueId === "iss_failed") throw new Error("upload unavailable");
        return archiveBinding();
      },
      onError: (workspaceDir, error) => errors.push(`${workspaceDir}:${error instanceof Error ? error.message : error}`),
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 1, orphaned: 0, skipped: 1 });
    expect(existsSync(failed)).toBe(true);
    expect(existsSync(ready)).toBe(false);
    expect(errors).toEqual([`${failed}:upload unavailable`]);
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

  it("never treats daemon-owned runtime model probe homes as orphan workspaces", async () => {
    const root = tempRoot();
    const probe = join(root, ".runtime-probe", "codex-daemon-hash", "home");
    mkdirSync(probe, { recursive: true });
    writeFileSync(join(probe, "config.toml"), 'model = "probe"\n');

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client: gcClient(),
      now: Date.now() + 24 * 60 * 60 * 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 0 });
    expect(readFileSync(join(probe, "config.toml"), "utf8")).toBe('model = "probe"\n');
  });

  it("rejects a workspace root symlink without touching its target", async () => {
    const owner = tempRoot();
    const outside = join(owner, "outside");
    const linkedRoot = join(owner, "linked-workspaces");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.txt"), "keep\n");
    symlinkSync(outside, linkedRoot, "dir");

    expect(await runWorkspaceGcOnce({
      root: linkedRoot,
      ttlMs: 0,
      orphanTtlMs: 0,
      client: gcClient(),
      now: Date.now() + 1_000,
    })).toEqual({ cleaned: 0, orphaned: 0, skipped: 0 });
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep\n");
  });

  it("fails closed when a GC parent is replaced by a symlink during status lookup", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".task-runtime");
    const taskDir = join(runtimeRoot, "tsk_race");
    const outside = tempRoot();
    const outsideTask = join(outside, "tsk_race");
    mkdirSync(join(taskDir, ".multiremi"), { recursive: true });
    writeFileSync(join(taskDir, ".multiremi", "gc.json"), JSON.stringify({
      version: 2,
      kind: "quick_create",
      task_id: "tsk_race",
    }));
    mkdirSync(outsideTask, { recursive: true });
    writeFileSync(join(outsideTask, "victim.txt"), "keep\n");
    const client = gcClient();
    client.getTaskGcCheck = async () => {
      rmSync(runtimeRoot, { recursive: true, force: true });
      symlinkSync(outside, runtimeRoot, "dir");
      return { status: "completed", completed_at: "2000-01-01T00:00:00.000Z" };
    };

    await expect(runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client,
      now: Date.now() + 1_000,
    })).rejects.toThrow("must be a real directory");
    expect(readFileSync(join(outsideTask, "victim.txt"), "utf8")).toBe("keep\n");
  });

  it("does not archive an Issue from a replacement workspace root", async () => {
    const root = tempRoot();
    issueWorkspace(root, "MUL-root-race", "iss_root_race");
    const original = lstatSync(root);
    const moved = `${root}-moved`;
    roots.push(moved);
    let archived = false;
    const client = gcClient();
    client.getIssueGcCheck = async () => {
      renameSync(root, moved);
      const replacement = issueWorkspace(root, "MUL-root-race", "iss_root_race");
      writeFileSync(join(replacement, "private.txt"), "replacement\n");
      return { status: "done", updated_at: "2000-01-01T00:00:00.000Z" };
    };

    const result = await runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      runtimeId: "rt_1",
      client,
      requireIssueSessionArchive: true,
      assertRootOwner: () => {
        const current = lstatSync(root);
        if (current.dev !== original.dev || current.ino !== original.ino) {
          throw new Error("workspace root identity changed");
        }
      },
      ensureIssueSessionArchive: async () => {
        archived = true;
        return archiveBinding();
      },
      now: Date.now() + 1_000,
    });

    expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(archived).toBe(false);
    expect(readFileSync(join(root, "MUL-root-race", "private.txt"), "utf8")).toBe("replacement\n");
  });

  it("does not remove a non-Issue directory from a replacement workspace root", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".task-runtime");
    const taskDir = join(runtimeRoot, "tsk_root_race");
    mkdirSync(join(taskDir, ".multiremi"), { recursive: true });
    writeFileSync(join(taskDir, ".multiremi", "gc.json"), JSON.stringify({
      version: 2,
      kind: "quick_create",
      task_id: "tsk_root_race",
    }));
    const original = lstatSync(root);
    const moved = `${root}-moved`;
    roots.push(moved);
    const client = gcClient();
    client.getTaskGcCheck = async () => {
      renameSync(root, moved);
      const replacement = join(root, ".task-runtime", "tsk_root_race");
      mkdirSync(replacement, { recursive: true });
      writeFileSync(join(replacement, "private.txt"), "replacement\n");
      return { status: "completed", completed_at: "2000-01-01T00:00:00.000Z" };
    };

    await expect(runWorkspaceGcOnce({
      root,
      ttlMs: 0,
      orphanTtlMs: 0,
      client,
      assertRootOwner: () => {
        const current = lstatSync(root);
        if (current.dev !== original.dev || current.ino !== original.ino) {
          throw new Error("workspace root identity changed");
        }
      },
      now: Date.now() + 1_000,
    })).rejects.toThrow("workspace root identity changed");
    expect(readFileSync(join(root, ".task-runtime", "tsk_root_race", "private.txt"), "utf8")).toBe("replacement\n");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-issue-gc-"));
  roots.push(root);
  return root;
}

function archiveBinding() {
  return {
    archiveId: "sar_ready",
    sourceRevision: "a".repeat(64),
    sha256: "b".repeat(64),
  };
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
