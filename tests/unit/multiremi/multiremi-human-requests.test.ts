import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createRunningTask(store: MultiremiStore): MultiremiTask {
  const agent = store.createAgent({ name: "HR Agent", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "test" });
  store.registerRuntime({ id: "rt_test", name: "test-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
  const claimed = store.claimTask("rt_test");
  expect(claimed?.id).toBe(task.id);
  return store.startTask(task.id);
}

describe("task human requests (store)", () => {
  it("keeps an issue in sync through queue, work, review, resume, and acceptance", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_issue_flow",
      name: "issue-flow-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const agent = store.createAgent({ name: "Issue Flow Agent", provider: "claude" });
    const issue = store.createIssue({ title: "Verify task-driven issue states", status: "in_review" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Implement it" });

    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("todo");

    store.startTask(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");

    const request = store.createTaskHumanRequest({
      taskId: task.id,
      kind: "permission",
      payload: { title: "Approve changes" },
    });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    store.respondTaskHumanRequest(request.id, {
      response: { option_id: "approve" },
      respondedBy: "user-1",
    });
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");

    store.completeTask(task.id, { output: "Ready for acceptance" });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    store.updateIssue(issue.id, { status: "done" });
    expect(store.getIssue(issue.id)?.status).toBe("done");
  });

  it("create parks the task; respond resumes it first-write-wins", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: { options: [] } });
    expect(request.status).toBe("pending");
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");

    const responded = store.respondTaskHumanRequest(request.id, { response: { option_id: "a" }, respondedBy: "user-1" });
    expect(responded?.status).toBe("responded");
    expect(responded?.respondedBy).toBe("user-1");
    expect(store.getTaskStatus(task.id)).toBe("running");

    // Losing side of the race gets null, stored response is untouched.
    expect(store.respondTaskHumanRequest(request.id, { response: { option_id: "b" } })).toBeNull();
    expect(store.getTaskHumanRequest(request.id)?.response).toEqual({ option_id: "a" });
  });

  it("expire loses to an existing response and wins over pending", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const first = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    store.respondTaskHumanRequest(first.id, { response: { option_id: "a" } });
    expect(store.expireTaskHumanRequest(first.id, "timeout")).toBeNull();
    expect(store.getTaskHumanRequest(first.id)?.status).toBe("responded");

    const second = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    const expired = store.expireTaskHumanRequest(second.id, "timeout");
    expect(expired?.status).toBe("timeout");
    expect(store.getTaskStatus(task.id)).toBe("running");
  });

  it("keeps the task parked until every pending request settles", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const a = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    const b = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    store.respondTaskHumanRequest(a.id, { response: { option_id: "x" } });
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");
    store.respondTaskHumanRequest(b.id, { response: { answers: { q: "y" } } });
    expect(store.getTaskStatus(task.id)).toBe("running");
  });

  it("an awaiting_human task can still be cancelled and completed", () => {
    const store = createStore();
    const task = createRunningTask(store);
    store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");
    // completeTask accepts in-flight statuses including awaiting_human — the
    // worker may finish after a timeout-expire raced with the final report.
    expect(store.completeTask(task.id, { output: "done" }).status).toBe("completed");

    const task2 = createRunningTask(store);
    store.createTaskHumanRequest({ taskId: task2.id, kind: "question", payload: {} });
    expect(store.cancelTask(task2.id).status).toBe("cancelled");
  });

  it("returns an issue to todo when a task fails while awaiting review", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_review_failure",
      name: "review-failure-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const agent = store.createAgent({ name: "Review Failure Agent", provider: "claude" });
    const issue = store.createIssue({ title: "Review failure" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Try it" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    store.failTask(task.id, { error: "approval channel closed", failureReason: "agent_error" });

    expect(store.getIssue(issue.id)?.status).toBe("todo");
  });

  it("counts awaiting_human toward runtime in-flight concurrency", () => {
    const store = createStore();
    const task = createRunningTask(store);
    store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    const runtime = store.getRuntime("rt_test")!;
    expect(runtime.activeTaskCount).toBeGreaterThanOrEqual(1);
  });
});
