import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { browseRuntimeDirectory, scanRuntimeDirectories } from "@multiremi/daemon.js";

let db: Database | null = null;

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("Bun Multiremi runtime directory scan", () => {
  it("runs the queue lifecycle create → claim → report", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_lifecycle", name: "Scan runtime", provider: "codex" });

    const request = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "~/code", maxDepth: 2 });
    expect(request.id).toStartWith("rds_");
    expect(request.runtimeId).toBe(runtime.id);
    expect(request.status).toBe("pending");
    expect(request.params).toEqual({ root: "~/code", maxDepth: 2 });
    expect(request.candidates).toEqual([]);
    expect(request.supported).toBe(true);
    expect(request.error).toBeNull();
    expect(request.runStartedAt).toBeNull();

    const claimed = store.claimRuntimeDirectoryScanRequest(runtime.id);
    expect(claimed?.id).toBe(request.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.runStartedAt).toBeString();
    // Nothing else pending → second claim yields null.
    expect(store.claimRuntimeDirectoryScanRequest(runtime.id)).toBeNull();

    const reported = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "completed",
      supported: true,
      candidates: [
        { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null },
        { path: "/home/dev/code/scratch", name: "scratch", remoteUrl: null, currentBranch: null, isDirty: null },
      ],
    });
    expect(reported.status).toBe("completed");
    expect(reported.error).toBeNull();
    expect(reported.candidates).toEqual([
      { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null },
      { path: "/home/dev/code/scratch", name: "scratch", remoteUrl: null, currentBranch: null, isDirty: null },
    ]);
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, request.id)?.status).toBe("completed");
  });

  it("reports failure with the daemon-provided error", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_failure", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id);
    store.claimRuntimeDirectoryScanRequest(runtime.id);

    const reported = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "failed",
      error: "directory does not exist: /nope",
    });
    expect(reported.status).toBe("failed");
    expect(reported.error).toBe("directory does not exist: /nope");
  });

  it("refuses to enqueue a scan for an offline runtime", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_offline", name: "Offline runtime", provider: "codex", status: "offline" });
    expect(runtime.status).toBe("offline");
    expect(() => store.createRuntimeDirectoryScanRequest(runtime.id)).toThrow("runtime is offline");
  });

  it("only claims a directory scan when the daemon advertises support", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_capability", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/srv/work", maxDepth: 4 });

    // A heartbeat without the capability must never claim the pending request.
    const withoutSupport = store.heartbeatRuntime(runtime.id, { supportsDirectoryScan: false });
    expect(withoutSupport.pending_directory_scan).toBeUndefined();
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, request.id)?.status).toBe("pending");

    // Default options also omit the capability.
    expect(store.heartbeatRuntime(runtime.id).pending_directory_scan).toBeUndefined();
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, request.id)?.status).toBe("pending");

    // Advertising support claims the request and embeds the params in the ack.
    const withSupport = store.heartbeatRuntime(runtime.id, { supportsDirectoryScan: true });
    expect(withSupport.pending_directory_scan).toEqual({ id: request.id, root: "/srv/work", max_depth: 4 });
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, request.id)?.status).toBe("running");
  });

  it("times out a pending scan the daemon never picks up", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_pending_timeout", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id);

    // Back-date created_at past the 3-minute pending window.
    const oldPendingAt = new Date(Date.now() - 3 * 60 * 1000 - 1000).toISOString();
    db!.run("UPDATE multiremi_runtime_directory_scan_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldPendingAt,
      oldPendingAt,
      request.id,
    ]);

    const expired = store.getRuntimeDirectoryScanRequest(runtime.id, request.id);
    expect(expired?.status).toBe("timeout");
    expect(expired?.error).toContain("the runtime daemon may need updating");
    // An expired pending request is no longer claimable.
    expect(store.claimRuntimeDirectoryScanRequest(runtime.id)).toBeNull();
  });

  it("times out a running scan the daemon never finishes", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_running_timeout", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id);
    store.claimRuntimeDirectoryScanRequest(runtime.id);

    // Back-date run_started_at past the 60-second running window.
    const oldRunningAt = new Date(Date.now() - 61 * 1000).toISOString();
    db!.run("UPDATE multiremi_runtime_directory_scan_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldRunningAt,
      oldRunningAt,
      request.id,
    ]);

    const expired = store.getRuntimeDirectoryScanRequest(runtime.id, request.id);
    expect(expired?.status).toBe("timeout");
    expect(expired?.error).toBe("daemon did not finish within 60 seconds");

    // A late report on a timed-out request is ignored (terminal).
    const late = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "completed",
      candidates: [{ path: "/late", name: "late", remoteUrl: null, currentBranch: null, isDirty: null }],
    });
    expect(late.status).toBe("timeout");
    expect(late.candidates).toEqual([]);
  });

  it("keeps a terminal result idempotent under repeated reports", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_idempotent", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id);
    store.claimRuntimeDirectoryScanRequest(runtime.id);

    const completed = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "completed",
      candidates: [{ path: "/home/dev/repo", name: "repo", remoteUrl: null, currentBranch: "main", isDirty: null }],
    });
    expect(completed.status).toBe("completed");

    // A second report (failed) must not overwrite the terminal completed state.
    const second = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, { status: "failed", error: "too late" });
    expect(second.status).toBe("completed");
    expect(second.error).toBeNull();
    expect(second.candidates).toEqual(completed.candidates);
  });

  it("serves the runtime directory scan HTTP flow across both URL variants", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_http", name: "Scan runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    // Native (camelCase) create.
    const nativeCreated = await app.request(`/api/multiremi/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: "~/code", max_depth: 3 }),
    });
    expect(nativeCreated.status).toBe(200);
    const nativeBody = await nativeCreated.json();
    expect(nativeBody.id).toStartWith("rds_");
    expect(nativeBody.status).toBe("pending");
    expect(nativeBody.runtimeId).toBe(runtime.id);
    expect(nativeBody.runtime_id).toBeUndefined();
    expect(nativeBody.params).toEqual({ root: "~/code", maxDepth: 3 });
    expect(nativeBody.candidates).toEqual([]);
    expect(nativeBody.supported).toBe(true);
    expect(nativeBody.runStartedAt).toBeNull();

    // The snake_case twin reads back the same underlying request.
    const compatDetail = await app.request(`/api/runtimes/${runtime.id}/directory-scans/${nativeBody.id}`);
    expect(compatDetail.status).toBe(200);
    const compatBody = await compatDetail.json();
    expect(compatBody.id).toBe(nativeBody.id);
    expect(compatBody.runtime_id).toBe(runtime.id);
    expect(compatBody.runtimeId).toBeUndefined();
    expect(compatBody.params).toEqual({ root: "~/code", max_depth: 3 });
    expect(compatBody.run_started_at).toBeNull();
    expect(compatBody.created_at).toBeString();
    expect(compatBody.createdAt).toBeUndefined();

    // Daemon claim moves the request to running.
    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const claimBody = await claim.json();
    expect(claimBody.request.id).toBe(nativeBody.id);
    expect(claimBody.request.status).toBe("running");

    // A report for a missing request is a 404.
    const missingReport = await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/rds_missing/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(missingReport.status).toBe(404);
    expect(await missingReport.json()).toEqual({ error: "request not found" });

    // Invalid JSON does not mutate the request (still running).
    const invalidReport = await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/${nativeBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidReport.status).toBe(400);
    expect(await invalidReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, nativeBody.id)?.status).toBe("running");

    // Daemon reports candidates: one with a remote, one without.
    const report = await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/${nativeBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        supported: true,
        candidates: [
          { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null },
          { path: "/home/dev/code/notes", name: "notes", remoteUrl: null, currentBranch: null, isDirty: null },
        ],
      }),
    });
    expect(report.status).toBe(200);
    expect(await report.json()).toEqual({ status: "ok" });

    // Native detail exposes camelCase candidate fields.
    const nativeDetail = await app.request(`/api/multiremi/runtimes/${runtime.id}/directory-scans/${nativeBody.id}`);
    const nativeDetailBody = await nativeDetail.json();
    expect(nativeDetailBody.status).toBe("completed");
    expect(nativeDetailBody.candidates[0]).toEqual({
      path: "/home/dev/code/app",
      name: "app",
      remoteUrl: "git@github.com:acme/app.git",
      currentBranch: "main",
      isDirty: null,
    });

    // Compat detail maps candidate fields to snake_case.
    const compatFinal = await app.request(`/api/runtimes/${runtime.id}/directory-scans/${nativeBody.id}`);
    const compatFinalBody = await compatFinal.json();
    expect(compatFinalBody.status).toBe("completed");
    expect(compatFinalBody.candidates).toEqual([
      { path: "/home/dev/code/app", name: "app", remote_url: "git@github.com:acme/app.git", current_branch: "main", is_dirty: null, is_git_repo: null },
      { path: "/home/dev/code/notes", name: "notes", remote_url: null, current_branch: null, is_dirty: null, is_git_repo: null },
    ]);

    // A late report once terminal is a no-op that still returns ok.
    const lateReport = await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/${nativeBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "too late" }),
    });
    expect(lateReport.status).toBe(200);
    expect(await lateReport.json()).toEqual({ status: "ok" });
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, nativeBody.id)?.status).toBe("completed");
  });

  it("rejects a directory scan for an offline runtime over HTTP with 503", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_http_offline", name: "Offline runtime", provider: "codex", status: "offline" });
    const app = createMultiremiApp({ store });

    const nativeOffline = await app.request(`/api/multiremi/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(nativeOffline.status).toBe(503);
    expect(await nativeOffline.json()).toEqual({ error: "runtime is offline" });

    const compatOffline = await app.request(`/api/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(compatOffline.status).toBe(503);
    expect(await compatOffline.json()).toEqual({ error: "runtime is offline" });
  });

  it("forbids initiating a directory scan on another owner's runtime", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_owned", name: "Owned runtime", provider: "codex", workspaceId: "local", ownerId: "someone-else" });
    const app = createMultiremiApp({ store });

    const forbidden = await app.request(`/api/multiremi/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "you can only access directory scans from your own runtimes" });

    const forbiddenCompat = await app.request(`/api/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(forbiddenCompat.status).toBe(403);
  });

  it("embeds the browse mode in params and the heartbeat ack", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_mode", name: "Scan runtime", provider: "codex" });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "~/code", mode: "browse" });
    expect(request.params).toEqual({ root: "~/code", mode: "browse" });

    const ack = store.heartbeatRuntime(runtime.id, { supportsDirectoryScan: true });
    expect(ack.pending_directory_scan).toEqual({ id: request.id, root: "~/code", mode: "browse" });
  });

  it("rejects an unknown scan mode", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_bad_mode", name: "Scan runtime", provider: "codex" });
    expect(() => store.createRuntimeDirectoryScanRequest(runtime.id, { mode: "sideways" as "scan" | "browse" }))
      .toThrow('directory scan mode must be "scan" or "browse"');
  });

  it("rejects an unknown scan mode over HTTP with 400 on both URL variants", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_bad_mode_http", name: "Scan runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    for (const path of [`/api/multiremi/runtimes/${runtime.id}/directory-scans`, `/api/runtimes/${runtime.id}/directory-scans`]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "sideways" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'directory scan mode must be "scan" or "browse"' });
    }
  });

  it("passes browse mode through the compat rail and emits is_git_repo", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_dirscan_browse_http", name: "Scan runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    const created = await app.request(`/api/runtimes/${runtime.id}/directory-scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: "~/code", mode: "browse" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.params).toEqual({ root: "~/code", mode: "browse" });

    // Daemon claims then reports a git child and a plain child, echoing the
    // expanded absolute root it browsed.
    await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/claim`, { method: "POST" });
    await app.request(`/api/daemon/runtimes/${runtime.id}/directory-scans/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        resolvedRoot: "/home/dev/code",
        candidates: [
          { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null, isGitRepo: true },
          { path: "/home/dev/code/scratch", name: "scratch", remoteUrl: null, currentBranch: null, isDirty: null, isGitRepo: false },
        ],
      }),
    });

    // Compat detail echoes mode + the resolved root and maps is_git_repo to snake_case.
    const compat = await app.request(`/api/runtimes/${runtime.id}/directory-scans/${createdBody.id}`);
    const compatBody = await compat.json();
    expect(compatBody.params).toEqual({ root: "~/code", mode: "browse", resolved_root: "/home/dev/code" });
    expect(compatBody.candidates).toEqual([
      { path: "/home/dev/code/app", name: "app", remote_url: "git@github.com:acme/app.git", current_branch: "main", is_dirty: null, is_git_repo: true },
      { path: "/home/dev/code/scratch", name: "scratch", remote_url: null, current_branch: null, is_dirty: null, is_git_repo: false },
    ]);

    // Native detail carries the camelCase isGitRepo + resolvedRoot through.
    const native = await app.request(`/api/multiremi/runtimes/${runtime.id}/directory-scans/${createdBody.id}`);
    const nativeBody = await native.json();
    expect(nativeBody.params).toEqual({ root: "~/code", mode: "browse", resolvedRoot: "/home/dev/code" });
    expect(nativeBody.candidates[0].isGitRepo).toBe(true);
    expect(nativeBody.candidates[1].isGitRepo).toBe(false);
  });
});

describe("scanRuntimeDirectories git metadata", () => {
  it("resolves a linked worktree's remote via the shared commondir config", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "remi-dirscan-"));
    try {
      // Main repo: a real `.git` dir holding the shared config + HEAD.
      const mainGit = join(tmpRoot, "repo", ".git");
      mkdirSync(mainGit, { recursive: true });
      writeFileSync(join(mainGit, "config"), '[remote "origin"]\n\turl = git@github.com:acme/widget.git\n');
      writeFileSync(join(mainGit, "HEAD"), "ref: refs/heads/main\n");

      // Linked worktree gitdir: no local `config`; `commondir` points back to the main .git.
      const linkedGitDir = join(mainGit, "worktrees", "feature");
      mkdirSync(linkedGitDir, { recursive: true });
      writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
      writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feature\n");

      // Worktree working dir: a `.git` file pointing at the linked gitdir.
      const worktree = join(tmpRoot, "wt");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

      const candidates = await scanRuntimeDirectories(tmpRoot, 3);
      const linked = candidates.find((c) => c.path === worktree);
      expect(linked).toBeDefined();
      expect(linked?.remoteUrl).toBe("git@github.com:acme/widget.git");
      expect(linked?.currentBranch).toBe("feature");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("browseRuntimeDirectory", () => {
  it("lists immediate child dirs with git metadata, hiding junk and dot-dirs", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "remi-dirbrowse-"));
    try {
      // A git repo child: real `.git` dir with a remote + HEAD.
      const repoGit = join(tmpRoot, "app", ".git");
      mkdirSync(repoGit, { recursive: true });
      writeFileSync(join(repoGit, "config"), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
      writeFileSync(join(repoGit, "HEAD"), "ref: refs/heads/main\n");
      // A plain (non-git) child dir.
      mkdirSync(join(tmpRoot, "notes"), { recursive: true });
      // A hidden dir and a junk dir that must both stay out of the listing.
      mkdirSync(join(tmpRoot, ".secret"), { recursive: true });
      mkdirSync(join(tmpRoot, "node_modules"), { recursive: true });
      // A top-level file is not a directory and must be ignored.
      writeFileSync(join(tmpRoot, "README.md"), "hi\n");

      const { candidates, resolvedRoot } = await browseRuntimeDirectory(tmpRoot);
      // The expanded absolute root is echoed back for the folder-picker UI.
      expect(resolvedRoot).toBe(tmpRoot);
      // Exactly the two visible directories, sorted by name.
      expect(candidates.map((c) => c.name)).toEqual(["app", "notes"]);

      const app = candidates.find((c) => c.name === "app")!;
      expect(app.path).toBe(join(tmpRoot, "app"));
      expect(app.isGitRepo).toBe(true);
      expect(app.remoteUrl).toBe("git@github.com:acme/app.git");
      expect(app.currentBranch).toBe("main");
      expect(app.isDirty).toBeNull();

      const notes = candidates.find((c) => c.name === "notes")!;
      expect(notes.isGitRepo).toBe(false);
      expect(notes.remoteUrl).toBeNull();
      expect(notes.currentBranch).toBeNull();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws when the browse root does not exist", async () => {
    await expect(browseRuntimeDirectory("/no/such/dir/remi-browse")).rejects.toThrow("directory does not exist:");
  });
});
