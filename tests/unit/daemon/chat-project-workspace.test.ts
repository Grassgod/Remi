import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { runWorkspaceGcOnce } from "@daemon/agent-runtime/workspace/gc.js";
import { writeTaskGcContext } from "@daemon/agent-runtime/skills/ephemeral.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(localPath?: string) {
  const root = mkdtempSync(join(tmpdir(), "remi-chat-project-"));
  roots.push(root);
  const task: AgentTask = {
    id: "task_first",
    workspaceId: "local",
    prompt: "Read this Project.",
    issueId: null,
    issue: null,
    chatSessionId: "chat_project",
    autopilotRunId: null,
    workDir: null,
    agent: null,
    repos: [],
    runtimeId: null,
    sessionId: null,
    triggerCommentId: null,
    triggerSummary: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    completedAt: null,
    project: { id: "project_chat", title: "Chat project", description: null },
    projectResources: localPath ? [{
      id: "resource_local",
      resourceType: "local_directory",
      resourceRef: { local_path: localPath, daemon_id: "daemon_owner" },
      label: null,
    }] : [],
  };
  const options = {
    daemonIds: ["daemon_owner"],
    workspacesRoot: root,
    locker: new LocalPathLocker(),
    signal: new AbortController().signal,
    onWaitLocalDirectory: (_taskId: string, _reason: string) => {},
  };
  return { root, task, options };
}

describe("Project-bound Chat workspaces", () => {
  it("never substitutes a later directory belonging to the executing daemon", async () => {
    const { root, task, options } = fixture();
    const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-unselected-"));
    roots.push(userRoot);
    writeTaskGcContext(userRoot, task, { localDirectory: true });
    const before = readFileSync(join(userRoot, ".multiremi", "gc.json"), "utf8");
    task.workDir = userRoot;
    task.sessionId = "old-provider";
    task.projectResources = [
      { id: "selected", resourceType: "local_directory", label: null,
        resourceRef: { local_path: "/not-on-this-machine", daemon_id: "selected-daemon" } },
      { id: "unselected", resourceType: "local_directory", label: null,
        resourceRef: { local_path: userRoot, daemon_id: "daemon_owner" } },
    ];
    expect(await resolveTaskWorkDir(task, options)).toEqual({
      workDir: join(root, "chats", task.chatSessionId!), localDirectory: false,
      ensureDir: true, resetSession: true,
    });
    expect(readFileSync(join(userRoot, ".multiremi", "gc.json"), "utf8")).toBe(before);
    expect(existsSync(join(userRoot, "wiki"))).toBe(false);
    expect(existsSync(join(userRoot, ".multiremi", "wiki-base"))).toBe(false);
  });

  it("still rejects duplicate physical-daemon aliases before selecting a directory", async () => {
    const { task, options } = fixture();
    options.daemonIds.push("legacy-owner");
    task.projectResources = [
      { id: "selected", resourceType: "local_directory", label: null,
        resourceRef: { local_path: "/first", daemon_id: "daemon_owner" } },
      { id: "duplicate", resourceType: "local_directory", label: null,
        resourceRef: { local_path: "/second", daemon_id: "legacy-owner" } },
    ];
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("multiple local_directory resources");
  });

  it("preserves daemon-local eligibility for non-Chat run-only tasks", async () => {
    const { root, task, options } = fixture();
    const localPath = join(root, "run-only-directory");
    mkdirSync(localPath);
    task.chatSessionId = null;
    task.projectResources = [
      { id: "other", resourceType: "local_directory", label: null,
        resourceRef: { local_path: "/not-on-this-machine", daemon_id: "other-daemon" } },
      { id: "local", resourceType: "local_directory", label: null,
        resourceRef: { local_path: localPath, daemon_id: "daemon_owner" } },
    ];
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved).toMatchObject({ workDir: localPath, localDirectory: true, ensureDir: false });
    expect(resolved.release).toBeFunction();
    resolved.release?.();
  });

  it("still rejects missing daemon IDs before selecting a directory", async () => {
    const { task, options } = fixture();
    task.projectResources = [{ id: "invalid", resourceType: "local_directory", label: null,
      resourceRef: { local_path: "/first" } }];
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("missing daemon_id");
  });

  for (const change of ["deleted", "path", "daemon"] as const) {
    it(`cold-starts in the Chat directory when an inherited user assignment is ${change}`, async () => {
      const { root, task, options } = fixture();
      const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-user-"));
      roots.push(userRoot);
      const newPath = join(userRoot, "new-directory");
      mkdirSync(newPath);
      writeFileSync(join(userRoot, "code.txt"), "keep");
      task.workDir = userRoot;
      task.sessionId = "old-provider";
      task.projectResources = change === "deleted" ? [] : [{
        id: "resource_local", resourceType: "local_directory", label: null,
        resourceRef: { local_path: change === "path" ? newPath : userRoot,
          daemon_id: change === "daemon" ? "another-daemon" : "daemon_owner" },
      }];
      expect(await resolveTaskWorkDir(task, options)).toEqual({
        workDir: join(root, "chats", task.chatSessionId!), localDirectory: false,
        ensureDir: true, resetSession: true,
      });
      expect(readFileSync(join(userRoot, "code.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(userRoot, ".multiremi"))).toBe(false);
      expect(existsSync(join(newPath, ".multiremi"))).toBe(false);
    });
  }

  it("retains a matching inherited user assignment under the FIFO lock", async () => {
    const { root, task, options } = fixture();
    const userPath = join(root, "user-directory");
    mkdirSync(userPath);
    task.workDir = userPath;
    task.sessionId = "existing-provider";
    task.projectResources = [{ id: "directory", resourceType: "local_directory", label: null,
      resourceRef: { local_path: userPath, daemon_id: "daemon_owner" } }];
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved).toMatchObject({ workDir: userPath, localDirectory: true, ensureDir: false });
    expect(resolved.resetSession).toBeUndefined();
    expect(resolved.release).toBeFunction();
    resolved.release?.();
  });

  it("does not adopt a marked user directory just because it lies below the daemon root", async () => {
    const { root, task, options } = fixture();
    const userPath = join(root, "user-directory");
    mkdirSync(userPath);
    writeTaskGcContext(userPath, task, { localDirectory: true });
    const before = readFileSync(join(userPath, ".multiremi", "gc.json"), "utf8");
    task.workDir = userPath;
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "chats", task.chatSessionId!), localDirectory: false,
      ensureDir: true, resetSession: true,
    });
    expect(readFileSync(join(userPath, ".multiremi", "gc.json"), "utf8")).toBe(before);
  });

  it("rejects inherited symlinks escaping the daemon root before creating any files", async () => {
    const { root, task, options } = fixture();
    const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-user-"));
    roots.push(userRoot);
    symlinkSync(userRoot, join(root, "alias"));
    task.workDir = join(root, "alias", "missing-child");
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "chats", task.chatSessionId!), localDirectory: false,
      resetSession: true,
    });
    expect(existsSync(join(userRoot, "missing-child"))).toBe(false);
  });

  it("fails closed when the fallback Chat directory is itself a user directory", async () => {
    const { root, task, options } = fixture();
    const fallback = join(root, "chats", task.chatSessionId!);
    mkdirSync(fallback, { recursive: true });
    writeTaskGcContext(fallback, task, { localDirectory: true });
    const before = readFileSync(join(fallback, ".multiremi", "gc.json"), "utf8");
    task.workDir = "/old-user-directory";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("not daemon-owned");
    expect(readFileSync(join(fallback, ".multiremi", "gc.json"), "utf8")).toBe(before);
  });

  it("does not create a fallback below a root marked as a user directory", async () => {
    const { root, task, options } = fixture();
    writeTaskGcContext(root, task, { localDirectory: true });
    const before = readFileSync(join(root, ".multiremi", "gc.json"), "utf8");
    task.workDir = root;
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("not daemon-owned");
    expect(existsSync(join(root, "chats"))).toBe(false);
    expect(readFileSync(join(root, ".multiremi", "gc.json"), "utf8")).toBe(before);
  });

  it("rejects linked metadata before it can overwrite a user directory's GC marker", async () => {
    const { root, task, options } = fixture();
    const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-user-"));
    roots.push(userRoot);
    const inherited = join(root, "inherited");
    mkdirSync(inherited);
    writeFileSync(join(userRoot, "gc.json"), '{"local_directory":false}');
    symlinkSync(userRoot, join(inherited, ".multiremi"));
    task.workDir = inherited;
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "chats", task.chatSessionId!), resetSession: true,
    });
    expect(readFileSync(join(userRoot, "gc.json"), "utf8")).toBe('{"local_directory":false}');
  });

  it("keeps the stable Chat directory when the Project has no local directory", async () => {
    const { root, task, options } = fixture();
    expect(await resolveTaskWorkDir(task, options)).toEqual({
      workDir: join(root, "chats", "chat_project"),
      localDirectory: false,
      ensureDir: true,
    });
  });

  it("uses the Project's existing real directory and never marks it daemon-owned", async () => {
    const { root, task, options } = fixture();
    const localPath = join(root, "user-repo");
    mkdirSync(localPath);
    task.projectResources = [{
      id: "resource_local", resourceType: "local_directory", label: null,
      resourceRef: { local_path: localPath, daemon_id: "daemon_owner" },
    }];
    const resolved = await resolveTaskWorkDir(task, options);
    try {
      expect(resolved).toMatchObject({ workDir: localPath, localDirectory: true, ensureDir: false });
      expect(resolved.release).toBeFunction();
      expect(existsSync(join(root, "chats", task.chatSessionId!))).toBe(false);
    } finally {
      resolved.release?.();
    }
  });

  it("serializes Chat tasks in FIFO order even when the same directory is reached by a symlink", async () => {
    const { root, task, options } = fixture();
    const localPath = join(root, "user-repo");
    const aliasPath = join(root, "user-repo-alias");
    mkdirSync(localPath);
    symlinkSync(localPath, aliasPath);
    task.projectResources = [{
      id: "resource_local", resourceType: "local_directory", label: null,
      resourceRef: { local_path: localPath, daemon_id: "daemon_owner" },
    }];
    const waiting: string[] = [];
    const acquired: string[] = [];
    const releases: Array<() => void> = [];
    const controller = new AbortController();
    options.signal = controller.signal;
    options.onWaitLocalDirectory = (id, reason) => {
      waiting.push(id);
      expect(reason).toContain("held by task task_fir");
    };
    const first = await resolveTaskWorkDir(task, options);
    releases.push(first.release!);
    try {
      const second = resolveTaskWorkDir({ ...task, id: "task_second", chatSessionId: "chat_second" }, options)
        .then((resolved) => { acquired.push("second"); releases.push(resolved.release!); return resolved; });
      const third = resolveTaskWorkDir({
        ...task, id: "task_third", chatSessionId: "chat_third",
        projectResources: [{ ...task.projectResources[0]!, resourceRef: { local_path: aliasPath, daemon_id: "daemon_owner" } }],
      }, options).then((resolved) => { acquired.push("third"); releases.push(resolved.release!); return resolved; });
      await Promise.resolve();
      expect(waiting).toEqual(["task_second", "task_third"]);
      expect(acquired).toEqual([]);
      first.release!();
      const secondResolved = await second;
      expect(acquired).toEqual(["second"]);
      secondResolved.release!();
      const thirdResolved = await third;
      expect(acquired).toEqual(["second", "third"]);
      expect(thirdResolved.workDir).toBe(aliasPath);
    } finally {
      controller.abort();
      for (const release of releases) release();
    }
  });

  it("rejects a missing user directory without falling back to an empty Chat directory", async () => {
    const { root, task, options } = fixture();
    task.projectResources = [{
      id: "resource_local", resourceType: "local_directory", label: null,
      resourceRef: { local_path: join(root, "missing"), daemon_id: "daemon_owner" },
    }];
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("path does not exist");
    expect(existsSync(join(root, "chats", task.chatSessionId!))).toBe(false);
  });

  it("preserves a user directory during GC even if it lies under the Chat root and the Chat was archived", async () => {
    const { root, task, options } = fixture();
    const localPath = join(root, "chats", task.chatSessionId!);
    mkdirSync(localPath, { recursive: true });
    writeFileSync(join(localPath, "user-code.txt"), "keep this code");
    task.projectResources = [{
      id: "resource_local", resourceType: "local_directory", label: null,
      resourceRef: { local_path: localPath, daemon_id: "daemon_owner" },
    }];
    const resolved = await resolveTaskWorkDir(task, options);
    try {
      writeTaskGcContext(localPath, task, { localDirectory: resolved.localDirectory });
      let chatChecks = 0;
      const terminal = async () => ({ status: "completed", updated_at: "2000-01-01T00:00:00.000Z" });
      const result = await runWorkspaceGcOnce({
        root, ttlMs: 0, orphanTtlMs: 0,
        client: {
          getIssueGcCheck: terminal,
          getTaskGcCheck: terminal,
          getAutopilotRunGcCheck: terminal,
          getChatSessionGcCheck: async () => {
            chatChecks++;
            return { status: "archived", updated_at: "2000-01-01T00:00:00.000Z" };
          },
        },
      });
      expect(result).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
      expect(chatChecks).toBe(0);
      expect(readFileSync(join(localPath, "user-code.txt"), "utf8")).toBe("keep this code");
    } finally {
      resolved.release?.();
    }
  });
});
