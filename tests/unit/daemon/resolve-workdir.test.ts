/**
 * Unit tests for resolveWorkDir (persistent workspace path resolution).
 *
 * Product surfaces have stable daemon-owned roots. An explicit promoted
 * machine-affine task.workDir always wins for provider-session continuity.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { resolveWorkDir } from "@daemon/agent-runtime/workspace/persistent.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const ROOT = "/tmp/multiremi-ws-root";

function task(partial: Record<string, unknown>): AgentTask {
  return { id: "t1", workspaceId: "ws1", workDir: null, agent: null, ...partial } as unknown as AgentTask;
}

test("explicit task.workDir wins over everything (daemon-owned, may create)", () => {
  expect(resolveWorkDir(task({ workDir: "/explicit/dir" }), ROOT)).toEqual({
    workDir: "/explicit/dir",
    ensureDir: true,
  });
});

test("issue key owns the stable Issue workspace path across tasks", () => {
  expect(resolveWorkDir(task({
    id: "tsk_second",
    issueId: "iss_1",
    issue: { id: "iss_1", key: "MUL-28" },
  }), ROOT)).toEqual({
    workDir: join(ROOT, "issues", "MUL-28"),
    ensureDir: true,
  });
});

test("discussion Issue Sessions use an isolated directory outside the Issue GC root", () => {
  const resolved = resolveWorkDir(task({
    id: "tsk_discussion",
    issueId: "iss_1",
    issueSessionId: "ises_side_chat",
    holdsWorkspace: false,
    issue: { id: "iss_1", key: "MUL-136" },
  }), ROOT);

  expect(resolved).toEqual({
    workDir: join(ROOT, "discussions", "MUL-136", "ises_side_chat"),
    ensureDir: true,
  });
  expect(resolved.workDir.startsWith(join(ROOT, "issues", "MUL-136"))).toBe(false);
});

test("discussion Session paths sanitize unsafe segments", () => {
  expect(resolveWorkDir(task({
    issueId: "iss_1",
    issueSessionId: "../../side/chat",
    holds_workspace: false,
    issue: { id: "iss_1", key: "../../MUL/136" },
  }), ROOT).workDir).toBe(join(ROOT, "discussions", "..-..-MUL-136", "..-..-side-chat"));
});

test("discussion Tasks fail closed when the Issue Session id is absent", () => {
  expect(() => resolveWorkDir(task({
    issueId: "iss_1",
    holdsWorkspace: false,
    issue: { id: "iss_1", key: "MUL-136" },
  }), ROOT)).toThrow("discussion task requires an issue session id");
});

test("chat Tasks use one stable directory per Chat Session", () => {
  expect(resolveWorkDir(task({ id: "t9", chatSessionId: "chat_1" }), ROOT)).toEqual({
    workDir: join(ROOT, "chats", "chat_1"),
    ensureDir: true,
  });
});

test("Issue-bound Chat Tasks stay in their Chat workspace", () => {
  expect(resolveWorkDir(task({
    id: "t10",
    chatSessionId: "chat_1",
    issueId: "iss_1",
    issue: { id: "iss_1", key: "MUL-226" },
  }), ROOT)).toEqual({
    workDir: join(ROOT, "chats", "chat_1"),
    ensureDir: true,
  });
});

test("one-shot work defaults to the per-Task directory", () => {
  expect(resolveWorkDir(task({ id: "t2", workspaceId: "wsY" }), ROOT)).toEqual({
    workDir: join(ROOT, "tasks", "t2"),
    ensureDir: true,
  });
});
