// Sibling test for packages/server/src/store/repos/usage-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { UsageRepo } from "@multiremi/store/repos/usage-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): UsageRepo {
  db = new Database(":memory:");
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

  it("carries totalTokens through the daily rollup so totals-only history is not erased", () => {
    const repo = createRepo();
    const runtime = store!.registerRuntime({ name: "totals-runtime", provider: "claude" });
    const agent = store!.createAgent({ name: "Totals worker", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store!.createTask({ agentId: agent.id, prompt: "history", workspaceId: "local" });
    store!.claimTask(runtime.id);
    store!.startTask(task.id);
    // Pre-0.2.49 daemons reported only the context-occupancy total.
    store!.reportTaskUsage(task.id, [{ provider: "claude", model: "opus", inputTokens: 0, outputTokens: 0, totalTokens: 78048 }]);
    store!.completeTask(task.id, { output: "done" });

    const daily = repo.listUsageDaily({ workspaceId: "local" });
    expect(daily.length).toBe(1);
    expect(daily[0]!.inputTokens).toBe(0);
    expect(daily[0]!.totalTokens).toBe(78048);
    const byAgent = repo.listUsageByAgent({ workspaceId: "local" });
    expect(byAgent[0]!.totalTokens).toBe(78048);
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
