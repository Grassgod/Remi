// Sibling test for packages/server/src/store/repos/tasks-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext, createCommitEventQueue } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { createResponsibleTestIssue } from './helpers.js';

pendingTurnBackendTests("TasksRepo", (fixture) => {
let store: MultiremiStore | null = null;
let ctx: StoreContext;

function createRepo(): TasksRepo {
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  const { db, store: currentStore } = fixture();
  store = currentStore;
  ctx = new StoreContext(db, () => store!);
  // The analytics recorders are not on the public facade, so they are registered on the context.
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  return new TasksRepo(ctx);
}

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

  for (const status of ["queued", "failed", "cancelled"] as const) {
    it(`redispatches a ${status} attempt and emits cancellation only when it changes status`, () => {
      const repo = createRepo();
      const { db } = fixture();
      const runtime = store!.registerRuntime({ name: "Retry runtime", provider: "codex" });
      const agent = store!.createAgent({ name: "Retry worker", provider: "codex" });
      const issue = createResponsibleTestIssue(store!,{ title: "Retry", assigneeType: "agent", assigneeId: agent.id });
      const task = repo.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Retry input", maxAttempts: 1 });
      const cancellations: string[] = [];
      const enqueued: string[] = [];
      ctx.taskEventListeners.add(event => { if (event.type === "task:cancelled") cancellations.push(event.task.id); });
      ctx.taskEnqueuedListeners.add(next => { enqueued.push(next.id); });
      try {
        if (status === "cancelled") repo.cancelTask(task.id);
        if (status === "failed") {
          repo.claimTask(runtime.id);
          repo.startTask(task.id);
          repo.failTask(task.id, { error: "Terminal failure" });
        }
        const previous = repo.getTask(task.id)!;
        const before = cancellations.length;
        const result = db.transaction(() => repo.redispatchTaskWithinTransaction(task.id, [], createCommitEventQueue()))();
        expect(cancellations).toHaveLength(before);
        repo.notifyRedispatchedTask(result);
        expect(cancellations).toHaveLength(before + (status === "queued" ? 1 : 0));
        expect(enqueued).toEqual([result.replacement.id]);
        expect(result.replacement).toMatchObject({ status: "queued", attempt: 2, parentTaskId: task.id });
        expect(store!.getTurnForAttempt(result.replacement.id)?.id).toBe(store!.getTurnForAttempt(task.id)?.id);
        if (status !== "queued") expect(repo.getTask(task.id)).toMatchObject({ status: previous.status,
          completedAt: previous.completedAt, failedAt: previous.failedAt, cancelledAt: previous.cancelledAt });
      } finally {
        // This case creates a separate Context; the reusable Store cannot own
        // or silently discard its per-case subscriptions.
        ctx.taskEventListeners.clear();
        ctx.taskEnqueuedListeners.clear();
      }
    });
  }

  it("still rejects redispatching a completed attempt without creating a replacement or cancelling it", () => {
    const repo = createRepo();
    const { db } = fixture();
    const runtime = store!.registerRuntime({ name: "Completed runtime", provider: "codex" });
    const agent = store!.createAgent({ name: "Completed worker", provider: "codex" });
    const task = repo.createTask({ agentId: agent.id, prompt: "Finish" });
    repo.claimTask(runtime.id);
    repo.startTask(task.id);
    repo.completeTask(task.id, { output: "Done" });
    const previous = repo.getTask(task.id)!;
    expect(() => db.transaction(() => repo.redispatchTaskWithinTransaction(task.id, [], createCommitEventQueue()))())
      .toThrow("Task not found or terminal");
    expect(repo.getTask(task.id)).toEqual(previous);
    expect(repo.listAgentTasks(agent.id)).toHaveLength(1);
  });
}, { isolation: 'committed-baseline' });
