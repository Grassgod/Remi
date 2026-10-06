// Sibling test for packages/server/src/store/repos/usage-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { UsageRepo } from "@multiremi/store/repos/usage-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): UsageRepo {
  db = openSqliteDatabase(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new UsageRepo(new StoreContext(db, () => store!));
}

function seedCompletedTaskWithUsage(): void {
  const runtime = store!.registerRuntime({ name: "usage-runtime", provider: "claude" });
  const agent = store!.createAgent({ name: "Usage worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store!.createTask({ agentId: agent.id, prompt: "burn tokens", workspaceId: "local" });
  store!.claimTask(runtime.id);
  store!.startTask(task.id);
  store!.reportTaskUsage(task.id, [
    { provider: "claude", model: "opus", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 },
  ]);
  store!.completeTask(task.id, { output: "done" });
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("UsageRepo", () => {
  it("returns empty rollups on a fresh database", () => {
    const repo = createRepo();
    expect(repo.listRuntimeUsage()).toEqual([]);
    expect(repo.listUsageDaily({ workspaceId: "local" })).toEqual([]);
  });

  it("rolls a task's reported usage into the daily and per-agent views", () => {
    const repo = createRepo();
    seedCompletedTaskWithUsage();

    const daily = repo.listUsageDaily({ workspaceId: "local" });
    expect(daily.length).toBe(1);
    expect(daily[0]!.inputTokens).toBe(100);
    expect(daily[0]!.outputTokens).toBe(20);

    const byAgent = repo.listUsageByAgent({ workspaceId: "local" });
    expect(byAgent.length).toBe(1);
    expect(byAgent[0]!.model).toBe("opus");
    expect(byAgent[0]!.cacheReadTokens).toBe(5);
    expect(byAgent[0]!.taskCount).toBe(1);
  });

  it("rejects a runtime filter that names no runtime", () => {
    const repo = createRepo();
    expect(() => repo.listUsageByHour({ workspaceId: "local", runtimeId: "rt_missing" })).toThrow("Runtime not found: rt_missing");
  });

  it("preserves ambiguous totals-only history as unknown evidence without counting consumption", () => {
    const repo = createRepo();
    const runtime = store!.registerRuntime({ name: "totals-runtime", provider: "claude" });
    const agent = store!.createAgent({ name: "Totals worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store!.createTask({ agentId: agent.id, prompt: "history", workspaceId: "local" });
    store!.claimTask(runtime.id);
    store!.startTask(task.id);
    // Legacy total semantics are ambiguous; context cannot be inferred either.
    store!.reportTaskUsage(task.id, [{ provider: "claude", model: "opus", inputTokens: 0, outputTokens: 0, totalTokens: 78048 }]);
    store!.completeTask(task.id, { output: "done" });

    const daily = repo.listUsageDaily({ workspaceId: "local" });
    expect(daily).toEqual([]);
    const byAgent = repo.listUsageByAgent({ workspaceId: "local" });
    expect(byAgent).toEqual([]);
    expect(store!.getUsageReport({ workspaceId: "local", days: null }).summary).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 1, context_peak_tokens: null, complete: false });
    expect(db!.query("SELECT reported_total_tokens FROM multiremi_usage_units WHERE task_id=?").get(task.id)).toMatchObject({ reported_total_tokens: 78048 });
  });

  it("projects unit occurrence dates and frozen scope even after task reassignment", () => {
    const repo = createRepo();
    const first = store!.registerRuntime({ name: "first", provider: "claude" });
    const second = store!.registerRuntime({ name: "second", provider: "claude" });
    const project = store!.createProject({ title: "Original", workspaceId: "local" });
    const otherProject = store!.createProject({ title: "Other", workspaceId: "local" });
    const issue = store!.createIssue({ title: "Work", workspaceId: "local", projectId: project.id });
    const agent = store!.createAgent({ name: "worker", workspaceId: "local", provider: "claude", runtimeId: first.id });
    const task = store!.createTask({ agentId: agent.id, issueId: issue.id, prompt: "cross day", workspaceId: "local" });
    store!.claimTask(first.id); store!.startTask(task.id);
    const units = ["2026-10-01T15:30:00Z", "2026-10-01T16:30:00Z"].map((occurredAt,index) => ({
      unitId: String(index), revision: 1, provider: "claude", model: "opus", source: "provider_request" as const, scope: "request" as const, accuracy: "exact" as const,
      inputTokens: (index + 1) * 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0,
      reportedTotalTokens: null, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt,
    }));
    store!.reportTaskUsageSnapshot(task.id, { version: 2, runId: "first-attempt", revision: 1, complete: true, units });
    db!.run("UPDATE multiremi_tasks SET runtime_id=? WHERE id=?", [second.id, task.id]);
    db!.run("UPDATE multiremi_issues SET project_id=? WHERE id=?", [otherProject.id, issue.id]);
    db!.run("UPDATE multiremi_tasks SET status='dispatched' WHERE id=?", [task.id]);
    store!.startTask(task.id, "second-attempt", second.id);
    store!.completeTask(task.id, { output: "done" });
    const daily = repo.listUsageDaily({ workspaceId: "local", runtimeId: first.id, projectId: project.id, days: 0, tz: "Asia/Shanghai" });
    expect(daily.map(row => [row.date, row.inputTokens, row.taskCount])).toEqual([["2026-10-01", 100, 1], ["2026-10-02", 200, 1]]);
    expect(repo.listRuntimeUsage(first.id)[0]?.inputTokens).toBe(300);
    expect(repo.listRuntimeUsage(second.id)).toEqual([]);
    expect(repo.listTaskActivityByHour({ workspaceId: "local", runtimeId: first.id, days: 0 })).toEqual([]);
    expect(repo.listAgentRuntime({ workspaceId: "local", runtimeId: second.id, projectId: otherProject.id, days: 0 })[0]?.taskCount).toBe(1);
  });

  it("rolls per-agent runtime totals that reconcile with the daily runtime series", () => {
    const repo = createRepo();
    seedCompletedTaskWithUsage();
    // A second agent whose task fails still counts toward run-time and failed_count.
    const runtime = store!.registerRuntime({ name: "failing-runtime", provider: "claude" });
    const agent = store!.createAgent({ name: "Failing worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store!.createTask({ agentId: agent.id, prompt: "will fail", workspaceId: "local" });
    store!.claimTask(runtime.id);
    store!.startTask(task.id);
    store!.failTask(task.id, { error: "boom" });

    const byAgent = repo.listAgentRuntime({ workspaceId: "local" });
    expect(byAgent.length).toBe(2);
    expect(byAgent.map((row) => row.taskCount).reduce((a, b) => a + b, 0)).toBe(2);
    expect(byAgent.find((row) => row.agentId === agent.id)).toMatchObject({ taskCount: 1, failedCount: 1 });

    const daily = repo.listRuntimeDaily({ workspaceId: "local" });
    const dailyTasks = daily.reduce((total, row) => total + row.taskCount, 0);
    const dailySeconds = daily.reduce((total, row) => total + row.totalSeconds, 0);
    expect(dailyTasks).toBe(2);
    expect(byAgent.reduce((total, row) => total + row.totalSeconds, 0)).toBe(dailySeconds);
  });
});
