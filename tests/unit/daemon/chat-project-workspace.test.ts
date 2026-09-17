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
