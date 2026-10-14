/**
 * Unit tests for resolveWorkDir (persistent workspace path resolution).
 *
 * Product surfaces have stable daemon-owned roots under `work/` and, for a
 * discussion Session, a private work set inside its lane generation. Inherited
 * machine-affine paths never decide where a Task runs.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { resolveWorkDir } from "@daemon/agent-runtime/workspace/persistent.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const ROOT = "/tmp/multiremi-ws-root";

function task(partial: Record<string, unknown>): AgentTask {
  return { id: "t1", workspaceId: "ws1", workDir: null, agent: null, ...partial } as unknown as AgentTask;
}

test("an inherited task.workDir does not decide where a Task runs", () => {
  expect(resolveWorkDir(task({ workDir: "/explicit/dir" }), ROOT)).toEqual({
    workDir: join(ROOT, "work", "t1"),
    ensureDir: true,
  });
});

test("the Issue id owns the stable Issue workspace path across tasks", () => {
  const expected = { workDir: join(ROOT, "work", "iss_1"), ensureDir: true };
  expect(resolveWorkDir(task({
    id: "tsk_second",
    issueId: "iss_1",
    issue: { id: "iss_1", key: "MUL-28" },
  }), ROOT)).toEqual(expected);
  expect(resolveWorkDir(task({ id: "tsk_third", issue_id: "iss_1" }), ROOT)).toEqual(expected);
});

test("discussion Issue Sessions work in their lane generation, outside the Issue workspace", () => {
  const resolved = resolveWorkDir(task({
    id: "tsk_discussion",
    issueId: "iss_1",
    issueSessionId: "ises_side_chat",
    issueSessionGeneration: 2,
    holdsWorkspace: false,
    agent: { id: "agt_1" },
    issue: { id: "iss_1", key: "MUL-136" },
  }), ROOT);

  expect(resolved).toEqual({
    workDir: join(ROOT, "env", "iss_1", "ises_side_chat", "agt_1", "main", "2", "work"),
    ensureDir: true,
  });
  expect(resolved.workDir.startsWith(join(ROOT, "work", "iss_1"))).toBe(false);
});

test("a delegated discussion keeps its own scope directory", () => {
  expect(resolveWorkDir(task({
    issueId: "iss_1",
    issueSessionId: "ises_1",
    holds_workspace: false,
    execution_scope: "dlg_7",
    agent: { id: "agt_1" },
  }), ROOT).workDir).toBe(join(ROOT, "env", "iss_1", "ises_1", "agt_1", "dlg_7", "1", "work"));
});

test("discussion Session paths sanitize unsafe segments", () => {
  expect(resolveWorkDir(task({
    issueId: "iss_1",
    issueSessionId: "../../side/chat",
    holds_workspace: false,
    agent: { id: "agt_1" },
    issue: { id: "iss_1", key: "../../MUL/136" },
  }), ROOT).workDir).toBe(join(ROOT, "env", "iss_1", "..-..-side-chat", "agt_1", "main", "1", "work"));
});

test("discussion Tasks fail closed when the Issue Session id is absent", () => {
  expect(() => resolveWorkDir(task({
    issueId: "iss_1",
    holdsWorkspace: false,
    agent: { id: "agt_1" },
    issue: { id: "iss_1", key: "MUL-136" },
  }), ROOT)).toThrow("discussion task requires an issue session id");
});

test("chat Tasks use one stable directory per Chat Session", () => {
  expect(resolveWorkDir(task({ id: "t9", chatSessionId: "chat_1" }), ROOT)).toEqual({
    workDir: join(ROOT, "work", "chat_1"),
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
    workDir: join(ROOT, "work", "chat_1"),
    ensureDir: true,
  });
});

test("one-shot work defaults to the per-Task directory", () => {
  expect(resolveWorkDir(task({ id: "t2", workspaceId: "wsY" }), ROOT)).toEqual({
    workDir: join(ROOT, "work", "t2"),
    ensureDir: true,
  });
});

test("a Chat flagged as a non-holder still runs in its own workspace", () => {
  expect(resolveWorkDir(task({
    id: "t11",
    chatSessionId: "chat_topic",
    issueId: "iss_1",
    holdsWorkspace: false,
    agent: { id: "agt_1" },
  }), ROOT)).toEqual({ workDir: join(ROOT, "work", "chat_topic"), ensureDir: true });
});
