// Sibling test for packages/server/src/store/repos/tasks-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): TasksRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  const ctx = new StoreContext(db, () => store!);
  // The analytics recorders are not on the public facade, so they are registered on the context.
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  return new TasksRepo(ctx);
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("TasksRepo", () => {
  it("creates a queued task against an agent and reads it back", () => {
    const repo = createRepo();
    // Agents live in another repo, reached through ctx.agents().
    const agent = store!.createAgent({ name: "Worker", provider: "claude", workspaceId: "local" });

    const task = repo.createTask({ agentId: agent.id, prompt: "build it" });
    expect(task.status).toBe("queued");
    expect(repo.getTask(task.id)?.prompt).toBe("build it");
    expect(repo.listTasks("queued").map((entry) => entry.id)).toEqual([task.id]);
    expect(repo.listAgentTasks(agent.id).map((entry) => entry.id)).toEqual([task.id]);
    expect(repo.getTaskStatus(task.id)).toBe("queued");
    expect(() => repo.createTask({ agentId: "agt_nope", prompt: "x" })).toThrow("Agent not found: agt_nope");
  });

  it("claims a task for a runtime and drives it to completion", () => {
    const repo = createRepo();
    // Runtimes live in another repo, reached through ctx.runtimes().
    const runtime = store!.registerRuntime({ id: "rt_worker", name: "Worker box", provider: "claude", workspaceId: "local" });
    const agent = store!.createAgent({ name: "Worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = repo.createTask({ agentId: agent.id, prompt: "ship it" });

    const claimed = repo.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("dispatched");
    expect(repo.startTask(task.id).status).toBe("running");
    expect(repo.reportProgress(task.id, "halfway", 1, 2).progressSummary).toBe("halfway");

    const done = repo.completeTask(task.id, { output: "shipped" });
    expect(done.status).toBe("completed");
    expect(repo.getTaskStatus(task.id)).toBe("completed");
    // A completed task no longer sits in the pool.
    expect(repo.claimTask(runtime.id)).toBeNull();
  });

  it("rejects progress on terminal tasks unless the write is a final summary", () => {
    const repo = createRepo();
    const runtime = store!.registerRuntime({ id: "rt_worker", name: "Worker box", provider: "claude", workspaceId: "local" });
    const agent = store!.createAgent({ name: "Worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = repo.createTask({ agentId: agent.id, prompt: "ship it" });
    repo.claimTask(runtime.id);
    repo.startTask(task.id);
    repo.completeTask(task.id, { output: "shipped" });

    expect(() => repo.reportProgress(task.id, "late", 1, 2)).toThrow("Task not found or terminal");
    const updated = repo.reportProgress(task.id, "任务已完成：交付成功", 3, 3, { allowTerminal: true });
    expect(updated.progressSummary).toBe("任务已完成：交付成功");
    expect(updated.status).toBe("completed");
    expect(() => repo.reportProgress("tsk_missing", "x", null, null, { allowTerminal: true }))
      .toThrow("Task not found or terminal");
  });

  it("appends task messages and notifies the context listeners", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Chatty", provider: "claude", workspaceId: "local" });
    const task = repo.createTask({ agentId: agent.id, prompt: "talk" });

    const appended = repo.appendTaskMessages(task.id, [
      { type: "text", content: "first" },
      { type: "tool_call", tool: "Bash", status: "completed" },
    ]);
    expect(appended.map((message) => message.type)).toEqual(["text", "tool_call"]);
    expect(repo.listTaskMessages(task.id).map((message) => message.seq)).toEqual([1, 2]);
    expect(repo.listTaskMessages(task.id, 1).map((message) => message.seq)).toEqual([2]);

    expect(repo.cancelTask(task.id).status).toBe("cancelled");
  });
});
