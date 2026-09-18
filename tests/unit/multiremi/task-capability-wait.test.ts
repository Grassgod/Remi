import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MODEL = "deepseek-flash";
const GRACE_MS = 120_000;
const ALERT_MS = 15 * 60_000;
const EVENT = "task_queued_capability_timeout";

function models(available = true): MultiremiRuntimeModel[] {
  return [{
    id: MODEL, label: "DeepSeek", provider: "openai", default: true,
    thinking: available
      ? { status: "supported", supportedLevels: [{ value: "high", label: "high" }], defaultLevel: "high" }
      : { status: "error", supportedLevels: [], error: "catalog HTTP 503 (fixture)" },
  }];
}

function fixture(binding: "automatic" | "runtime" | "group" | "task" = "automatic") {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "codex", {
    fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
    tokenOp: "set", authToken: "fixture-token",
  });
  const runtime = store.registerRuntime({
    name: "Candidate", provider: "codex", workspaceId: "local",
    executionGroupId: "capability-group", models: models(), maxConcurrency: 1,
  });
  store.saveGatewayModels("local", "codex", {
    sourceRevision: revision, nativeCatalogStatus: "ready",
    models: [{ id: MODEL, label: "DeepSeek", thinking: models()[0]!.thinking }],
  });
  const agent = store.createAgent({
    name: "Capability waiter", provider: "codex", model: MODEL, thinkingLevel: "high",
    ...(binding === "runtime" ? { runtimeId: runtime.id }
      : binding === "group" ? { executionGroupId: "capability-group" } : {}),
  });
  const task = store.createTask({
    agentId: agent.id, prompt: "Wait for the configured model",
    ...(binding === "task" ? { runtimeId: runtime.id } : {}),
  });
  const now = Date.now();
  ageTask(task.id, GRACE_MS, now);
  const fail = () => store.updateRuntimeModels(runtime.id, models(false));
  const recover = () => store.updateRuntimeModels(runtime.id, models());
  return { store, runtime, agent, task, now, fail, recover };
}

function ageTask(taskId: string, ageMs: number, now: number) {
  db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - ageMs).toISOString(), taskId]);
}

describe("queued task model capability waits", () => {
  it("keeps the grace period silent, then explains all rejected candidates without changing the task or model", () => {
    const { store, runtime, agent, task, now, fail } = fixture();
    const second = store.registerRuntime({ name: "Second", provider: "codex", workspaceId: "local", models: models(false) });
    fail();
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(second.id)).toBeNull();
    const events: string[] = [];
    store.onTaskEvent(({ type }) => events.push(type));

    expect(store.refreshQueuedCapabilityWaitReasons(now - 1)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(task.id)?.waitReason).toBeNull();
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 0 });
    const waiting = store.getTask(task.id)!;
    expect(waiting.status).toBe("queued");
    expect(waiting.waitReason).toContain(MODEL);
    expect(waiting.waitReason).toContain("high");
    expect(waiting.waitReason).toContain("2");
    expect(events).toEqual(["task:queued"]);
    expect(store.getAgent(agent.id)).toMatchObject({ model: MODEL, thinkingLevel: "high" });
    expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(0);
  });

  it("explains unavailable native membership even without a thinking override", () => {
    const { store, runtime, now } = fixture();
    const agent = store.createAgent({ name: "Native member waiter", provider: "codex", model: MODEL });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait for native model membership" });
    ageTask(task.id, GRACE_MS, now);
    store.updateRuntimeModels(runtime.id, [{
      id: "bundled-gpt", label: "Bundled GPT", provider: "openai", default: true,
      catalog: { status: "error", error: "catalog HTTP 503 (fixture)" },
    }]);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: expect.stringContaining(MODEL) });
    expect(store.getTask(task.id)?.waitReason).not.toContain("thinking:");
  });

  for (const state of ["online", "offline", "busy"] as const) {
    it(`does not warn while another capable candidate is ${state}`, () => {
      const { store, task, now, fail } = fixture();
      fail();
      const healthy = store.registerRuntime({ name: "Healthy", provider: "codex", workspaceId: "local", models: models(), maxConcurrency: 1 });
      if (state === "offline") store.setRuntimeOffline(healthy.id);
      if (state === "busy") {
        const worker = store.createAgent({ name: "Busy worker", provider: "codex", runtimeId: healthy.id });
        const active = store.createTask({ agentId: worker.id, prompt: "Occupy the healthy runtime", priority: 100 });
        expect(store.claimTask(healthy.id)?.id).toBe(active.id);
        store.startTask(active.id);
        expect(store.getRuntime(healthy.id)?.activeTaskCount).toBe(1);
      }
      ageTask(task.id, ALERT_MS, now);
      expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
      expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: null });
      expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(0);
    });
  }

  it("leaves an empty routing candidate set unlabelled", () => {
    const { store, runtime, task, now } = fixture();
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    ageTask(task.id, ALERT_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(task.id)?.waitReason).toBeNull();
  });

  it("explains a task pinned to an incapable runtime despite another capable runtime", () => {
    const { store, runtime, agent, task, now, fail, recover } = fixture("task");
    const healthy = store.registerRuntime({ name: "Healthy", provider: "codex", workspaceId: "local", models: models() });
    fail();
    expect(agent.runtimeId).toBeNull();
    expect(task.runtimeId).toBe(runtime.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(healthy.id)).toBeNull();

    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 0 });
    expect(store.getTask(task.id)).toMatchObject({
      status: "queued", runtimeId: runtime.id,
      waitReason: expect.stringContaining(`1 个候选 Runtime 均无法执行 ${MODEL}`),
    });
    recover();
    expect(store.claimTask(runtime.id)).toMatchObject({ id: task.id, status: "dispatched", waitReason: null });
  });

  it("evaluates runtime pins independently for tasks sharing an agent", () => {
    const { store, runtime, agent, task: unpinned, now, fail } = fixture();
    const healthy = store.registerRuntime({ name: "Healthy", provider: "codex", workspaceId: "local", models: models() });
    const blocked = store.createTask({ agentId: agent.id, runtimeId: runtime.id, prompt: "Pinned to incapable runtime" });
    const runnable = store.createTask({ agentId: agent.id, runtimeId: healthy.id, prompt: "Pinned to capable runtime" });
    for (const task of [blocked, runnable]) ageTask(task.id, GRACE_MS, now);
    fail();

    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 0 });
    expect(store.getTask(blocked.id)?.waitReason).toContain(MODEL);
    expect(store.getTask(runnable.id)?.waitReason).toBeNull();
    expect(store.getTask(unpinned.id)?.waitReason).toBeNull();
  });

  it("leaves a task with no routing-eligible pinned runtime unlabelled", () => {
    const { store, agent, now, fail } = fixture();
    const workspace = store.createWorkspace({ name: "Other workspace", slug: "pinned-capability" });
    const foreign = store.registerRuntime({ name: "Foreign runtime", provider: "codex", workspaceId: workspace.id, models: models(false) });
    const task = store.createTask({ agentId: agent.id, runtimeId: foreign.id, prompt: "Unroutable pin" });
    ageTask(task.id, ALERT_MS, now);
    fail();

    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: foreign.id, waitReason: null });
    expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(0);
  });

  for (const restriction of ["owner", "provider", "workspace", "group", "runtime"] as const) {
    it(`excludes healthy runtimes that fail the ${restriction} routing constraint`, () => {
      const { store, task, now, fail } = fixture(restriction === "group" || restriction === "runtime" ? restriction : "automatic");
      const workspace = restriction === "workspace"
        ? store.createWorkspace({ name: "Other workspace", slug: "other-capability" }).id : "local";
      store.registerRuntime({
        name: "Ineligible healthy runtime", workspaceId: workspace,
        provider: restriction === "provider" ? "claude" : "codex", models: models(),
        ...(restriction === "owner" ? { ownerId: "another-owner", visibility: "private" as const } : {}),
        ...(restriction === "group" ? { executionGroupId: "another-capability-group" } : {}),
      });
      fail();
      expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 0 });
      expect(store.getTask(task.id)?.waitReason).toContain(MODEL);
    });
  }

  it("clears a previous capability reason when the last candidate loses routing eligibility", () => {
    const { store, runtime, task, now, fail } = fixture();
    fail();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(store.refreshQueuedCapabilityWaitReasons(now + 60_000)).toEqual({ updated: 1, alerted: 0 });
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: null });
  });

  it("clears the reason on capability recovery even while the recovered runtime is offline", () => {
    const { store, runtime, task, now, fail, recover } = fixture();
    fail();
    store.refreshQueuedCapabilityWaitReasons(now);
    recover();
    store.setRuntimeOffline(runtime.id);
    const cleared: Array<string | null> = [];
    store.onTaskEvent(({ type, task: updated }) => { if (type === "task:queued") cleared.push(updated.waitReason); });
    expect(store.refreshQueuedCapabilityWaitReasons(now + 60_000)).toEqual({ updated: 1, alerted: 0 });
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: null });
    expect(cleared).toEqual([null]);
  });

  it("clears the reason immediately on claim without waiting for the next scan", () => {
    const { store, runtime, task, now, fail, recover } = fixture();
    fail();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toContain(MODEL);
    recover();
    const claimed = store.claimTask(runtime.id);
    expect(claimed).toMatchObject({ id: task.id, status: "dispatched", waitReason: null });
    expect(store.startTask(task.id)).toMatchObject({ status: "running", waitReason: null });
  });

  it("escalates once, retaining the persisted notice across later scans and a store restart", () => {
    const { store, task, now, fail } = fixture();
    fail();
    store.refreshQueuedCapabilityWaitReasons(now);
    ageTask(task.id, ALERT_MS - 1, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.refreshQueuedCapabilityWaitReasons(now + 1)).toEqual({ updated: 1, alerted: 1 });
    const escalated = store.getTask(task.id)!;
    expect(escalated.waitReason).toContain(MODEL);
    expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(1);
    for (const elapsed of [60_000, 5 * 60_000, 60 * 60_000]) {
      expect(store.refreshQueuedCapabilityWaitReasons(now + elapsed)).toEqual({ updated: 0, alerted: 0 });
      expect(store.getTask(task.id)?.updatedAt).toBe(escalated.updatedAt);
    }
    expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(1);
    const restarted = new MultiremiStore(db!);
    expect(restarted.refreshQueuedCapabilityWaitReasons(now + 2 * 60 * 60_000)).toEqual({ updated: 0, alerted: 0 });
    expect(restarted.getTask(task.id)?.waitReason).toBe(escalated.waitReason);
    expect(restarted.listAnalyticsEvents({ name: EVENT })).toHaveLength(0);
  });

  it("updates an escalated candidate count without emitting the warning again", () => {
    const { store, task, now, fail } = fixture();
    fail();
    ageTask(task.id, ALERT_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 1 });
    store.registerRuntime({ name: "Another unavailable candidate", provider: "codex", workspaceId: "local", models: models(false) });
    expect(store.refreshQueuedCapabilityWaitReasons(now + 60_000)).toEqual({ updated: 1, alerted: 0 });
    expect(store.getTask(task.id)?.waitReason).toContain("2");
    expect(store.listAnalyticsEvents({ name: EVENT })).toHaveLength(1);
    const counters = store.listMetricCounters({ name: "multiremi_task_queued_capability_timeout_total" });
    expect(counters).toHaveLength(1);
    expect(counters[0]?.value).toBe(1);
  });

  it("does not overwrite unrelated reasons or nonqueued task state", () => {
    const { store, agent, task, now, fail } = fixture();
    const directory = store.createTask({ agentId: agent.id, prompt: "Directory lock" });
    const human = store.createTask({ agentId: agent.id, prompt: "Human reply" });
    db!.run("UPDATE multiremi_tasks SET wait_reason = ? WHERE id = ?", ["Existing queue dependency", task.id]);
    db!.run("UPDATE multiremi_tasks SET status = 'waiting_local_directory', wait_reason = ? WHERE id = ?", ["/tmp/held-worktree", directory.id]);
    db!.run("UPDATE multiremi_tasks SET status = 'awaiting_human', wait_reason = ? WHERE id = ?", ["Approval needed", human.id]);
    for (const id of [task.id, directory.id, human.id]) ageTask(id, ALERT_MS, now);
    fail();
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: "Existing queue dependency" });
    expect(store.getTask(directory.id)).toMatchObject({ status: "waiting_local_directory", waitReason: "/tmp/held-worktree" });
    expect(store.getTask(human.id)).toMatchObject({ status: "awaiting_human", waitReason: "Approval needed" });
  });

  it("clears an owned reason on cancellation without waiting for the scanner", () => {
    const { store, task, now, fail } = fixture();
    fail();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.cancelTask(task.id)).toMatchObject({ status: "cancelled", waitReason: null });
    expect(store.refreshQueuedCapabilityWaitReasons(now + ALERT_MS)).toEqual({ updated: 0, alerted: 0 });
  });
});
