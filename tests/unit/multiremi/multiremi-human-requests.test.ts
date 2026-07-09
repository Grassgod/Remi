import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

function createRunningTask(store: MultiremiStore): MultiremiTask {
  const agent = store.createAgent({ name: "HR Agent", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "test" });
  store.registerRuntime({ id: "rt_test", name: "test-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
  const claimed = store.claimTask("rt_test");
  expect(claimed?.id).toBe(task.id);
  return store.startTask(task.id);
}

describe("task human requests (store)", () => {
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

  it("counts awaiting_human toward runtime in-flight concurrency", () => {
    const store = createStore();
    const task = createRunningTask(store);
    store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    const runtime = store.getRuntime("rt_test")!;
    expect(runtime.activeTaskCount).toBeGreaterThanOrEqual(1);
  });
});
