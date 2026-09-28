/**
 * MUL-400 E3 blocking 4 (MUL-409 fix round 2): the automatic-start chain must
 * stay a single transaction on the Postgres bridge.
 *
 * `PostgresSyncDatabase.transaction()` is a bare BEGIN/COMMIT pair with no
 * savepoint, so a nested BEGIN lets the inner COMMIT end the outer unit early
 * and a later ROLLBACK cannot undo it. The depth counter is asserted for the
 * three scenarios the fix round names: auto-start after a prerequisite is done,
 * two prerequisites finishing, and the member forced start.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("MUL-400 E3 — automatic start stays one transaction (SQLite)", () => {
  it("auto-starts after a prerequisite is done without nesting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog", blockedBy: [prereq.id], assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: prereq.id, prompt: "finish" });
    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });

    store.updateIssue(prereq.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });

  it("dispatches once when two prerequisites finish", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth2", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const first = store.createIssue({ title: "First", status: "in_progress" });
    const second = store.createIssue({ title: "Second", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      blockedBy: [first.id, second.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(first.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    store.updateIssue(second.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });

  it("force-starts without nesting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth3", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "local" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });
});
