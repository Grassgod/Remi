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

  // MUL-449: a hard-affinity task pinned behind a Project device binding is
  // visible instead of silently queued, and device routing outranks model
  // capability because placement is refused before capability matters.
  function deviceFixture() {
    const store = createLocalStore();
    const devbox = store.registerRuntime({
      id: "rt_device_a", name: "devbox-a", provider: "codex", workspaceId: "local", daemonId: "device-routing-a",
    });
    const other = store.registerRuntime({
      id: "rt_device_b", name: "devbox-b", provider: "codex", workspaceId: "local", daemonId: "device-routing-b",
    });
    const agent = store.createAgent({ name: "Device waiter", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Bound then moved", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "device-routing-a" });
    const issue = store.createIssue({ title: "Device issue", projectId: project.id, workspaceId: "local" });
    const parent = store.createIssueSession(issue.id, { title: "Main", holdsWorkspace: true });
    const seed = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "seed" });
    store.claimTask(devbox.id);
    store.startTask(seed.id);
    store.completeTask(seed.id, { output: "ok", sessionId: "sess_device" });
    const move = () => {
      store.deleteProjectDevice(project.id, "device-routing-a");
      store.createProjectDevice(project.id, { daemonId: "device-routing-b" });
    };
    return { store, devbox, other, agent, project, issue, parent, move };
  }

  it("explains a hard-affinity task pinned behind a Project device binding", () => {
    const { store, devbox, other, agent, issue, parent, move } = deviceFixture();
    const side = store.createIssueSession(issue.id, {
      title: "Code side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "snapshot work",
    });
    move();
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toMatchObject({ updated: 1 });
    const waiting = store.getTask(task.id)!;
    expect(waiting.status).toBe("queued");
    expect(waiting.waitReason).toContain("等待项目设备：");
    expect(waiting.waitReason).toContain("devbox-a");
    expect(waiting.waitReason).toContain("代码快照");
    // The remedy must actually clear the pin: `remi task redispatch` would
    // mint another task carrying the same hard affinity.
    expect(waiting.waitReason).not.toContain("redispatch");
    expect(waiting.waitReason).toContain("设备绑定");
    // A snapshot exists only on A, so neither machine may take the turn — and
    // the reason must survive that refusal instead of being recomputed away.
    expect(store.claimTask(devbox.id)).toBeNull();
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("clears the device wait reason once the Project binding admits the machine again", () => {
    const { store, devbox, project, agent, issue, parent, move } = deviceFixture();
    const side = store.createIssueSession(issue.id, {
      title: "Code side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "snapshot work",
    });
    move();
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toContain("等待项目设备：");

    store.deleteProjectDevice(project.id, "device-routing-b");
    store.createProjectDevice(project.id, { daemonId: "device-routing-a" });
    expect(store.refreshQueuedCapabilityWaitReasons(now + GRACE_MS)).toMatchObject({ updated: 1 });
    expect(store.getTask(task.id)?.waitReason).toBeNull();
    expect(store.claimTask(devbox.id)?.id).toBe(task.id);
  });

  it("prefers the device-routing reason over a model-capability reason and back", () => {
    const { store, devbox, agent, issue, parent, move } = deviceFixture();
    // Make the pinned runtime model-incapable too, so both reasons would apply.
    store.updateRuntimeModels(devbox.id, [{
      id: MODEL, label: "DeepSeek", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "catalog HTTP 503 (fixture)" },
    }]);
    store.updateAgent(agent.id, { model: MODEL, thinkingLevel: "high" });
    const side = store.createIssueSession(issue.id, {
      title: "Code side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "both wait",
    });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);

    // Placement is refused first: device routing owns the text.
    move();
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toContain("等待项目设备：");

    // Binding restored, but the pinned machine still cannot run the model: the
    // observer falls back to the capability reason it also owns.
    store.deleteProjectDevice(issue.projectId!, "device-routing-b");
    store.createProjectDevice(issue.projectId!, { daemonId: "device-routing-a" });
    expect(store.refreshQueuedCapabilityWaitReasons(now + GRACE_MS).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toContain("等待模型能力恢复：");

    // And back again, so neither reason can strand the other.
    store.deleteProjectDevice(issue.projectId!, "device-routing-a");
    store.createProjectDevice(issue.projectId!, { daemonId: "device-routing-b" });
    expect(store.refreshQueuedCapabilityWaitReasons(now + 2 * GRACE_MS).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toContain("等待项目设备：");
  });

  it("explains a held Issue workspace pinned behind a moved device binding", () => {
    const { store, devbox, other, agent, issue, parent, move } = deviceFixture();
    // The Issue workspace is a real row on the devbox, so its data pins the
    // turn there independently of the lane.
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: devbox.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "ready",
      repos: [],
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "workspace work",
    });
    expect(task.holdsWorkspace).toBe(true);
    expect(task.runtimeId).toBe(devbox.id);
    move();

    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toBe(
      "等待项目设备：任务钉在 devbox-a（Issue 工作区），该机器不在项目的设备绑定里或为独享设备；"
      + "请把该机器加回项目的设备绑定，或取消它的独享设置",
    );
    // The workspace data only exists on the devbox: keep waiting, don't move it.
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: devbox.id, status: "queued" });
  });

  it("explains a frozen retry that is never re-pooled", () => {
    const { store, devbox, agent, issue, parent, move } = deviceFixture();
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "frozen retry",
    });
    db!.run(
      `UPDATE multiremi_tasks SET runtime_id = ?, session_id = 'sess_frozen', work_dir = '/work/frozen',
         attempt = 2, execution_fingerprint = 'frozen-fingerprint' WHERE id = ?`,
      [devbox.id, task.id],
    );
    move();
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toContain("等待项目设备：");

    // A frozen retry keeps its pin and its session; only the reason is added.
    expect(store.getTask(task.id)).toMatchObject({
      runtimeId: devbox.id, sessionId: "sess_frozen", workDir: "/work/frozen", attempt: 2,
    });
  });

  // MUL-449 QA round 2, blocker 2: a hard affinity can name a daemon whose
  // Runtime row does not exist yet. The daemon-scoped routing probe must still
  // resolve the Project, or one such task aborts the whole sweep.
  it("survives a hard affinity pinned to an unregistered Runtime", () => {
    const store = createLocalStore();
    const registered = store.registerRuntime({
      id: "rt_unreg_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-unreg-b",
    });
    const agent = store.createAgent({ name: "Unregistered pin", provider: "codex", workspaceId: "local" });
    const project = store.createProject({
      title: "Awaiting machine", workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/unreg", daemon_id: "dev-unreg-missing" } }],
    });
    store.createProjectDevice(project.id, { daemonId: "dev-unreg-b" });
    const issue = store.createIssue({ title: "Unregistered issue", projectId: project.id, workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "wait for its machine" });
    db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", ["rt_unregistered_daemon", task.id]);

    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(() => store.refreshQueuedCapabilityWaitReasons(now)).not.toThrow();
    const waiting = store.getTask(task.id)!;
    expect(waiting.waitReason).toContain("等待项目设备：");
    expect(waiting.waitReason).toContain("dev-unreg-missing");
    expect(waiting.waitReason).toContain("本机目录");
    // The registered-but-forbidden machine still cannot take it.
    expect(store.claimTask(registered.id)).toBeNull();
  });

  it("keeps a no-Project task with an unregistered pin scanable", () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Projectless pin", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "project-less" });
    db!.run(
      `UPDATE multiremi_tasks SET runtime_id = ?, attempt = 2, execution_fingerprint = 'frozen'
        WHERE id = ?`,
      ["rt_projectless_missing", task.id],
    );
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(() => store.refreshQueuedCapabilityWaitReasons(now)).not.toThrow();
    // No Project means no device binding to violate, so nothing is written.
    expect(store.getTask(task.id)?.waitReason).toBeNull();
  });

  // MUL-449 QA round 2, blocker 3: the label described the wrong pin, and the
  // suggested remedy could not clear a hard affinity.
  it("labels a Chat directory pin as the local directory, not an Issue workspace", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_label_dir_a", name: "Directory host", provider: "codex", workspaceId: "local", daemonId: "dev-label-a",
    });
    const b = store.registerRuntime({
      id: "rt_label_dir_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-label-b",
    });
    const agent = store.createAgent({ name: "Chat directory", provider: "codex", workspaceId: "local" });
    const project = store.createProject({
      title: "Chat directory project", workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/label-a", daemon_id: "dev-label-a" } }],
    });
    store.createProjectDevice(project.id, { daemonId: "dev-label-a" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id, workspaceId: "local" });
    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_label", workDir: "/abs/label-a" });
    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", [a.id, second.id]);

    store.deleteProjectDevice(project.id, "dev-label-a");
    store.createProjectDevice(project.id, { daemonId: "dev-label-b" });
    const now = Date.now();
    ageTask(second.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(second.id)!.waitReason!;
    expect(reason).toContain("本机目录");
    expect(reason).not.toContain("Issue 工作区");
    // `redispatch` mints another task with the same hard affinity, so the text
    // must not recommend it.
    expect(reason).not.toContain("redispatch");
    expect(store.claimTask(b.id)).toBeNull();
  });

  it("does not label a lease-free Issue task as holding a workspace", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_label_issue_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-label-issue-a",
    });
    const b = store.registerRuntime({
      id: "rt_label_issue_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-label-issue-b",
    });
    const agent = store.createAgent({ name: "Lease-free issue", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Lease-free project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-label-issue-a" });
    const issue = store.createIssue({ title: "Lease-free issue", projectId: project.id, workspaceId: "local" });
    // `holds_workspace = 1` (the Issue default) but no workspace row exists yet,
    // so the pin is provider lineage rather than a lease on one machine.
    const session = store.createIssueSession(issue.id, { title: "Work", holdsWorkspace: true });
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_lease_free" });
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(second).toMatchObject({ holdsWorkspace: true, runtimeId: a.id });
    expect(store.getIssueWorkspace(issue.id)).toBeNull();
    store.deleteProjectDevice(project.id, "dev-label-issue-a");
    store.createProjectDevice(project.id, { daemonId: "dev-label-issue-b" });

    const now = Date.now();
    ageTask(second.id, GRACE_MS, now);
    // Soft affinity: the observer writes nothing and the claim re-pools it.
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(second.id)?.waitReason).toBeNull();
    expect(store.claimTask(a.id)).toBeNull();
    // Re-pooling clears any text the observer owned before the pin moved.
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, waitReason: null });
    expect(store.claimTask(b.id)?.id).toBe(second.id);
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
