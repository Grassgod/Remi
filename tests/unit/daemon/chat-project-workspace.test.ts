import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { upsertSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";

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
    writeFileSync(join(userRoot, "code.txt"), "keep");
    task.workDir = userRoot;
    task.sessionId = "old-provider";
    task.projectResources = [
      { id: "selected", resourceType: "local_directory", label: null,
        resourceRef: { local_path: "/not-on-this-machine", daemon_id: "selected-daemon" } },
      { id: "unselected", resourceType: "local_directory", label: null,
        resourceRef: { local_path: userRoot, daemon_id: "daemon_owner" } },
    ];
    expect(await resolveTaskWorkDir(task, options)).toEqual({
      workDir: join(root, "work", task.chatSessionId!), localDirectory: false,
      ensureDir: true, resetSession: true,
    });
    expect(readFileSync(join(userRoot, "code.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(userRoot, ".multiremi"))).toBe(false);
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
        workDir: join(root, "work", task.chatSessionId!), localDirectory: false,
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

  it("does not adopt a user directory just because it lies below the daemon root", async () => {
    const { root, task, options } = fixture();
    const userPath = join(root, "user-directory");
    mkdirSync(userPath);
    writeFileSync(join(userPath, "code.txt"), "keep");
    task.workDir = userPath;
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "work", task.chatSessionId!), localDirectory: false,
      ensureDir: true, resetSession: true,
    });
    expect(readFileSync(join(userPath, "code.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(userPath, ".multiremi"))).toBe(false);
  });

  it("does not adopt a directory under an old layout name either", async () => {
    const { root, task, options } = fixture();
    task.workDir = join(root, "chats", task.chatSessionId!);
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "work", task.chatSessionId!), resetSession: true,
    });
    expect(existsSync(join(root, "chats"))).toBe(false);
  });

  it("keeps the session when the inherited directory is the Chat's own", async () => {
    const { root, task, options } = fixture();
    task.workDir = join(root, "work", task.chatSessionId!);
    task.sessionId = "existing-provider";
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved).toEqual({ workDir: task.workDir, localDirectory: false, ensureDir: true });
    expect(resolved.resetSession).toBeUndefined();
  });

  it("rejects inherited symlinks escaping the daemon root before creating any files", async () => {
    const { root, task, options } = fixture();
    const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-user-"));
    roots.push(userRoot);
    symlinkSync(userRoot, join(root, "alias"));
    task.workDir = join(root, "alias", "missing-child");
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "work", task.chatSessionId!), localDirectory: false,
      resetSession: true,
    });
    expect(existsSync(join(userRoot, "missing-child"))).toBe(false);
  });

  it("fails closed when the fallback Chat directory is itself a recorded user directory", async () => {
    const { root, task, options } = fixture();
    const fallback = join(root, "work", task.chatSessionId!);
    mkdirSync(fallback, { recursive: true });
    writeFileSync(join(fallback, "user-code.txt"), "keep");
    upsertSubjectRecord(root, {
      subject: { kind: "chat", id: task.chatSessionId! }, workspace_id: "local", external_work_dir: fallback,
    });
    task.workDir = "/old-user-directory";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("not daemon-owned");
    expect(readFileSync(join(fallback, "user-code.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(fallback, ".multiremi"))).toBe(false);
  });

  it("keeps working when the subject record is unreadable", async () => {
    const { root, task, options } = fixture();
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(join(root, "registry", `${task.chatSessionId}.json`), "{");
    expect(await resolveTaskWorkDir(task, options)).toEqual({
      workDir: join(root, "work", task.chatSessionId!), localDirectory: false, ensureDir: true,
    });
  });

  it("does not adopt inherited metadata that links out of the daemon root", async () => {
    const { root, task, options } = fixture();
    const userRoot = mkdtempSync(join(tmpdir(), "remi-chat-user-"));
    roots.push(userRoot);
    const inherited = join(root, "inherited");
    mkdirSync(inherited);
    symlinkSync(userRoot, join(inherited, ".multiremi"));
    task.workDir = inherited;
    expect(await resolveTaskWorkDir(task, options)).toMatchObject({
      workDir: join(root, "work", task.chatSessionId!), resetSession: true,
    });
    expect(existsSync(join(userRoot, "task.json"))).toBe(false);
  });

  it("keeps the stable Chat directory when the Project has no local directory", async () => {
    const { root, task, options } = fixture();
    expect(await resolveTaskWorkDir(task, options)).toEqual({
      workDir: join(root, "work", "chat_project"),
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
      expect(existsSync(join(root, "work", task.chatSessionId!))).toBe(false);
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
    expect(existsSync(join(root, "work", task.chatSessionId!))).toBe(false);
  });

  it("never treats a Project directory under the Chat's own path as daemon-owned afterwards", async () => {
    const { root, task, options } = fixture();
    const localPath = join(root, "work", task.chatSessionId!);
    mkdirSync(localPath, { recursive: true });
    writeFileSync(join(localPath, "user-code.txt"), "keep this code");
    task.projectResources = [{
      id: "resource_local", resourceType: "local_directory", label: null,
      resourceRef: { local_path: localPath, daemon_id: "daemon_owner" },
    }];
    const resolved = await resolveTaskWorkDir(task, options);
    try {
      expect(resolved).toMatchObject({ workDir: localPath, localDirectory: true, ensureDir: false });
      upsertSubjectRecord(root, {
        subject: { kind: "chat", id: task.chatSessionId! }, workspace_id: "local", external_work_dir: localPath,
      });
    } finally {
      resolved.release?.();
    }
    task.projectResources = [];
    task.workDir = localPath;
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("not daemon-owned");
    expect(readFileSync(join(localPath, "user-code.txt"), "utf8")).toBe("keep this code");
  });
});
