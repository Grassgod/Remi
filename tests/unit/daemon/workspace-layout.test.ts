import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  codeViewsRoot,
  conversationForTask,
  envDirectory,
  executionLaneForTask,
  holdsWorkspace,
  usesSharedWorkspace,
  isLayoutRootEntry,
  laneForTask,
  laneGenerationDirectory,
  laneGenerationWorkDirectory,
  laneWorkDirectory,
  legacyDirectory,
  pluginRuntimeBaseDirectory,
  probeRoot,
  quarantineRoot,
  registryFile,
  registrySnapshotWikiDirectory,
  rootRelative,
  segment,
  sharedReposRoot,
  subjectForTask,
  taskTmpRoot,
  tracePath,
  workDirectory,
} from "@daemon/agent-runtime/workspace/layout.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const ROOT = "/data/workspaces";

function task(partial: Record<string, unknown>): AgentTask {
  return {
    id: "tsk_1", workspaceId: "ws1", workDir: null, issueId: null, chatSessionId: null,
    agent: { id: "agent_1", provider: "claude" }, ...partial,
  } as unknown as AgentTask;
}

describe("subjectForTask", () => {
  test("an Issue task belongs to its Issue id", () => {
    expect(subjectForTask(task({ issueId: "iss_1" }))).toEqual({ kind: "issue", id: "iss_1" });
    expect(subjectForTask(task({ issue_id: "iss_2" }))).toEqual({ kind: "issue", id: "iss_2" });
  });

  test("a Chat task belongs to its Chat, even when an Issue came along", () => {
    expect(subjectForTask(task({ chatSessionId: "chat_1" }))).toEqual({ kind: "chat", id: "chat_1" });
    expect(subjectForTask(task({ chatSessionId: "chat_1", issueId: "iss_1" }))).toEqual({ kind: "chat", id: "chat_1" });
  });

  test("an execution with neither falls back to its task id", () => {
    expect(subjectForTask(task({}))).toEqual({ kind: "task", id: "tsk_1" });
    expect(subjectForTask(task({ chatSessionId: "  " }))).toEqual({ kind: "task", id: "tsk_1" });
  });
});

describe("lane identity", () => {
  test("conversation is the Issue session, the Chat, or the task", () => {
    expect(conversationForTask(task({ issueId: "iss_1", issueSessionId: "ises_9" }))).toBe("ises_9");
    expect(conversationForTask(task({ issueId: "iss_1" }))).toBe("iss_1");
    expect(conversationForTask(task({ chatSessionId: "chat_1" }))).toBe("chat_1");
    expect(conversationForTask(task({}))).toBe("tsk_1");
  });

  test("lane carries agent, scope and generation with defaults", () => {
    expect(laneForTask(task({ issueId: "iss_1", issueSessionId: "ises_9", issueSessionGeneration: 3, execution_scope: "dlg_2" }))).toEqual({
      subject: { kind: "issue", id: "iss_1" },
      conversation: "ises_9",
      agentId: "agent_1",
      scope: "dlg_2",
      generation: 3,
    });
    expect(laneForTask(task({ chatSessionId: "chat_1" }))?.generation).toBe(1);
    expect(laneForTask(task({ chatSessionId: "chat_1", issue_session_generation: 0 }))?.generation).toBe(1);
    expect(laneForTask(task({ agent: null }))).toBeNull();
  });

  test("a task holds the workspace unless it says otherwise", () => {
    expect(holdsWorkspace(task({}))).toBe(true);
    expect(holdsWorkspace(task({ holdsWorkspace: false }))).toBe(false);
    expect(holdsWorkspace(task({ holds_workspace: false }))).toBe(false);
  });

  test("only an Issue discussion works outside the subject's shared workspace", () => {
    expect(usesSharedWorkspace(task({ issueId: "iss_1" }))).toBe(true);
    expect(usesSharedWorkspace(task({ issueId: "iss_1", holdsWorkspace: false }))).toBe(false);
    // A Chat bound to an Issue topic is flagged as a non-holder, yet works in the Chat's own workspace.
    expect(usesSharedWorkspace(task({ chatSessionId: "chat_1", issueId: "iss_1", holdsWorkspace: false }))).toBe(true);
    expect(usesSharedWorkspace(task({}))).toBe(true);
  });
});

describe("execution lane", () => {
  const holder = { issueId: "iss_1", issueSessionId: "ises_1", issueSessionGeneration: 2 };

  test("an Issue holder starts in its lane's private directory, not in the shared workspace", () => {
    const lane = executionLaneForTask(task({ ...holder, execution_scope: "dlg_1" }));
    expect(lane).toEqual(laneForTask(task({ ...holder, execution_scope: "dlg_1" })));
    expect(laneWorkDirectory(ROOT, lane!)).toBe(join(ROOT, "env", "iss_1", "ises_1", "agent_1", "dlg_1", "2", "work"));
    expect(laneWorkDirectory(ROOT, lane!)).not.toBe(workDirectory(ROOT, lane!.subject));
  });

  test("concurrent holders of one Issue get distinct directories", () => {
    const first = executionLaneForTask(task({ ...holder, execution_scope: "dlg_1" }))!;
    const second = executionLaneForTask(task({ ...holder, execution_scope: "dlg_2" }))!;
    const other = executionLaneForTask(task({ ...holder, execution_scope: "dlg_1", agent: { id: "agent_2", provider: "claude" } }))!;
    const directories = [first, second, other].map((lane) => laneWorkDirectory(ROOT, lane));
    expect(new Set(directories).size).toBe(3);
    expect(new Set([first, second, other].map((lane) => workDirectory(ROOT, lane.subject))).size).toBe(1);
  });

  test("every other execution starts in its workspace", () => {
    expect(executionLaneForTask(task({ ...holder, holdsWorkspace: false }))).toBeNull();
    expect(executionLaneForTask(task({ chatSessionId: "chat_1" }))).toBeNull();
    expect(executionLaneForTask(task({ chatSessionId: "chat_1", issueId: "iss_1" }))).toBeNull();
    expect(executionLaneForTask(task({}))).toBeNull();
    expect(executionLaneForTask(task({ ...holder, runtimeWorkspaceId: "rw_1" }))).toBeNull();
  });
});

describe("path builders", () => {
  const issue = { kind: "issue", id: "iss_1" } as const;
  const lane = laneForTask(task({ issueId: "iss_1", issueSessionId: "ises_9", issueSessionGeneration: 2 }))!;
  const delegated = laneForTask(task({ issueId: "iss_1", issueSessionId: "ises_9", execution_scope: "dlg_2" }))!;

  test("records and workspaces are keyed by subject", () => {
    expect(registryFile(ROOT, issue)).toBe(join(ROOT, "registry", "iss_1.json"));
    expect(registrySnapshotWikiDirectory(ROOT, issue)).toBe(join(ROOT, "registry", "iss_1.snapshot", "wiki"));
    expect(workDirectory(ROOT, issue)).toBe(join(ROOT, "work", "iss_1"));
    expect(envDirectory(ROOT, issue)).toBe(join(ROOT, "env", "iss_1"));
    expect(taskTmpRoot(ROOT, issue)).toBe(join(ROOT, "env", "iss_1", "tmp"));
    expect(tracePath(ROOT, issue, "tsk_7")).toBe(join(ROOT, "traces", "iss_1", "tsk_7.jsonl"));
    expect(tracePath(ROOT, "iss_1", "tsk_7")).toBe(tracePath(ROOT, issue, "tsk_7"));
  });

  test("a lane generation nests conversation, agent, scope and generation", () => {
    expect(laneGenerationDirectory(ROOT, lane)).toBe(join(ROOT, "env", "iss_1", "ises_9", "agent_1", "main", "2"));
    expect(laneGenerationDirectory(ROOT, delegated)).toBe(join(ROOT, "env", "iss_1", "ises_9", "agent_1", "dlg_2", "1"));
    expect(laneWorkDirectory(ROOT, lane)).toBe(join(laneGenerationDirectory(ROOT, lane), "work"));
    expect(laneGenerationWorkDirectory(laneGenerationDirectory(ROOT, lane))).toBe(laneWorkDirectory(ROOT, lane));
    expect(pluginRuntimeBaseDirectory(ROOT, lane)).toBe(laneGenerationDirectory(ROOT, lane));
  });

  test("a worktree below a lane's work directory is recorded by its place below the root", () => {
    expect(rootRelative(ROOT, join(laneWorkDirectory(ROOT, lane), "experiment")))
      .toBe("env/iss_1/ises_9/agent_1/main/2/work/experiment");
    expect(rootRelative(ROOT, ROOT)).toBe("");
  });

  test("shared caches and daemon state have fixed homes", () => {
    expect(sharedReposRoot(ROOT)).toBe(join(ROOT, "shared", "repos"));
    expect(codeViewsRoot(ROOT)).toBe(join(ROOT, "shared", "code-views"));
    expect(probeRoot(ROOT)).toBe(join(ROOT, ".daemon", "probe"));
    expect(quarantineRoot(ROOT)).toBe(join(ROOT, ".daemon", "quarantine"));
    expect(legacyDirectory(ROOT, new Date("2026-10-13T08:00:00Z"))).toBe(join(ROOT, "legacy-20261013"));
  });

  test("root entries of the current layout are recognized", () => {
    for (const name of ["registry", "work", "env", "traces", "shared", ".daemon", "_topics", "legacy-20261013"]) {
      expect(isLayoutRootEntry(name)).toBe(true);
    }
    for (const name of ["issues", "chats", "tasks", "discussions", ".runtime", ".repos", ".snapshots", "MUL-1"]) {
      expect(isLayoutRootEntry(name)).toBe(false);
    }
  });

  test("ids that cannot be a single path segment are rejected, others are flattened", () => {
    expect(segment("../../x", "id")).toBe("..-..-x");
    expect(() => segment("..", "id")).toThrow(/invalid id/);
    expect(() => segment("   ", "id")).toThrow(/invalid id/);
    expect(() => workDirectory(ROOT, { kind: "chat", id: "/" })).toThrow(/invalid subject id/);
  });
});
