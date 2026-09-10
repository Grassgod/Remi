import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiTask, MultiremiTaskStatus } from "@multiremi/contracts/types.js";
import { isActiveTaskStatus } from "@multiremi/store/helpers.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function legacySnapshot(store: MultiremiStore, workspaceId: string): MultiremiTask[] {
  const tasks = store.listTasks().filter((task) => task.workspaceId === workspaceId);
  const snapshot = new Map<string, MultiremiTask>();
  for (const task of tasks) {
    if (isActiveTaskStatus(task.status)) snapshot.set(task.id, task);
  }
  const latestOutcomeByAgent = new Map<string, MultiremiTask>();
  for (const task of tasks.filter((item) => item.status === "completed" || item.status === "failed")) {
    const current = latestOutcomeByAgent.get(task.agentId);
    const taskOutcome = Date.parse(task.completedAt ?? task.failedAt ?? task.updatedAt ?? task.createdAt);
    const currentOutcome = current
      ? Date.parse(current.completedAt ?? current.failedAt ?? current.updatedAt ?? current.createdAt)
      : Number.NEGATIVE_INFINITY;
    if (!current || taskOutcome > currentOutcome) latestOutcomeByAgent.set(task.agentId, task);
  }
  for (const task of latestOutcomeByAgent.values()) snapshot.set(task.id, task);
  return [...snapshot.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function setTaskState(input: {
  id: string;
  status: MultiremiTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  failedAt?: string | null;
}): void {
  db!.run(
    `UPDATE multiremi_tasks
     SET status = ?, created_at = ?, updated_at = ?, completed_at = ?, failed_at = ?
     WHERE id = ?`,
    [input.status, input.createdAt, input.updatedAt, input.completedAt ?? null, input.failedAt ?? null, input.id],
  );
}

function expectSnapshotMatchesLegacy(store: MultiremiStore, workspaceId: string): void {
  expect(store.listWorkspaceAgentTaskSnapshot(workspaceId)).toEqual(legacySnapshot(store, workspaceId));
}

describe("listWorkspaceAgentTaskSnapshot", () => {
  it("returns every active task in updated order", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Active agent", provider: "codex" });
    const statuses = [
      "queued",
      "dispatched",
      "running",
      "waiting_local_directory",
      "awaiting_human",
    ] as const;
    statuses.forEach((status, index) => {
      const task = store.createTask({ agentId: agent.id, prompt: status });
      setTaskState({
        id: task.id,
        status,
        createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        updatedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
      });
    });

    expectSnapshotMatchesLegacy(store, "local");
    expect(store.listWorkspaceAgentTaskSnapshot("local").map((task) => task.status)).toEqual([...statuses].reverse());
  });

  it("returns one terminal outcome per agent and excludes cancelled tasks", () => {
    const store = createStore();
    const completedAgent = store.createAgent({ name: "Completed agent", provider: "codex" });
    const failedAgent = store.createAgent({ name: "Failed agent", provider: "codex" });
    const completed = store.createTask({ agentId: completedAgent.id, prompt: "completed" });
    const failed = store.createTask({ agentId: failedAgent.id, prompt: "failed" });
    const cancelled = store.createTask({ agentId: failedAgent.id, prompt: "cancelled" });
    setTaskState({ id: completed.id, status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-03T00:00:00.000Z", completedAt: "2026-02-03T00:00:00.000Z" });
    setTaskState({ id: failed.id, status: "failed", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z", failedAt: "2026-02-02T00:00:00.000Z" });
    setTaskState({ id: cancelled.id, status: "cancelled", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-02-04T00:00:00.000Z" });

    expectSnapshotMatchesLegacy(store, "local");
    expect(store.listWorkspaceAgentTaskSnapshot("local").map((task) => task.id)).toEqual([completed.id, failed.id]);
  });

  it("uses outcome time to select the latest terminal task for an agent", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Outcome agent", provider: "codex" });
    const earlierOutcome = store.createTask({ agentId: agent.id, prompt: "earlier outcome" });
    const laterOutcome = store.createTask({ agentId: agent.id, prompt: "later outcome" });
    setTaskState({ id: earlierOutcome.id, status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-10T00:00:00.000Z", completedAt: "2026-02-05T00:00:00.000Z" });
    setTaskState({ id: laterOutcome.id, status: "failed", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-09T00:00:00.000Z", failedAt: "2026-02-08T00:00:00.000Z" });

    expectSnapshotMatchesLegacy(store, "local");
    expect(store.listWorkspaceAgentTaskSnapshot("local").map((task) => task.id)).toEqual([laterOutcome.id]);
  });

  it("does not mix tasks from another workspace", () => {
    const store = createStore();
    const otherWorkspace = store.createWorkspace({ name: "Other workspace", slug: "other-workspace" });
    const localAgent = store.createAgent({ name: "Local agent", provider: "codex" });
    const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: otherWorkspace.id });
    const localTask = store.createTask({ agentId: localAgent.id, prompt: "local" });
    const otherTask = store.createTask({ agentId: otherAgent.id, prompt: "other" });
    setTaskState({ id: localTask.id, status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" });
    setTaskState({ id: otherTask.id, status: "running", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z" });

    expectSnapshotMatchesLegacy(store, "local");
    expectSnapshotMatchesLegacy(store, otherWorkspace.id);
    expect(store.listWorkspaceAgentTaskSnapshot("local").map((task) => task.id)).toEqual([localTask.id]);
    expect(store.listWorkspaceAgentTaskSnapshot(otherWorkspace.id).map((task) => task.id)).toEqual([otherTask.id]);
  });

  it("returns an empty result when the workspace has no tasks", () => {
    const store = createStore();

    expectSnapshotMatchesLegacy(store, "local");
    expect(store.listWorkspaceAgentTaskSnapshot("local")).toEqual([]);
  });

  it("looks up autopilot runs in batches when the snapshot exceeds 500 tasks", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Large snapshot agent", provider: "codex" });
    const tasks = Array.from({ length: 501 }, (_, index) => store.createTask({
      agentId: agent.id,
      prompt: `task ${index}`,
    }));
    const runId = "apr_large_snapshot";
    db!.run(
      `INSERT INTO multiremi_autopilot_runs (
        id, autopilot_id, source, status, task_id, triggered_at, created_at
      ) VALUES (?, ?, 'api', 'running', ?, ?, ?)`,
      [runId, "apl_large_snapshot", tasks.at(-1)!.id, "2026-09-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z"],
    );

    const snapshot = store.listWorkspaceAgentTaskSnapshot("local");

    expect(snapshot).toHaveLength(501);
    expect(snapshot.find((task) => task.id === tasks.at(-1)!.id)?.autopilotRunId).toBe(runId);
  });
});
