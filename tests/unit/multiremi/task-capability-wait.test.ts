import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, turnApiPath, sentTask, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { deviceRoutingRepair, placementWaitReason } from "@multiremi/store/task-wait-reason.js";
import { canRepoolQueuedTaskPin, REPOOLABLE_QUEUED_TASK_SQL } from "@multiremi/store/repos/tasks-repo.js";
import { createLocalStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";

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
  mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET created_at = ? WHERE id = ?", [new Date(now - ageMs).toISOString(), taskId]);
}

async function redispatchAsSupervisor(store: MultiremiStore, taskId: string, reason: string) {
  store.createWorkspaceMember({ workspaceId: "local", userId: "owner", name: "Owner", role: "owner" });
  const workspace = store.getWorkspace("local")!;
  store.updateWorkspace("local", { settings: {
    ...workspace.settings, organizer: { mode: "act" },
  } });
  const supervisor = store.createAgent({ name: "Organizer", provider: "claude", role: "supervisor" });
  store.setAgentSupervisor(supervisor.id, true);
  const patrol = createResponsibleTestIssue(store, { title: "Organizer patrol" });
  const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "organize" });
  const token = await store.createTaskAccessToken(supervisorTask, "owner");
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const response = await app.request(turnApiPath(store, taskId, "/retry"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cold: true, reason }),
  });
  return { response, replacement: response.status === 200
    ? store.getTask((await response.json()).turn.current_attempt_id) : null };
}

describe("queued task model capability waits", () => {
  for (const dedicated of [false, true]) {
    for (const location of ["local", "other", "archived", "foreign-tenant", "none"] as const) {
      it(`matches explicit-workspace routing and repair state (${location}, dedicated=${dedicated})`, () => {
        const store = createLocalStore();
        const a = store.registerRuntime({ name: "A", provider: "codex", daemonId: "explicit-a", metadata: { runtime_workspaces: 1 } });
        const b = store.registerRuntime({ name: "B", provider: "codex", daemonId: "explicit-b", metadata: { runtime_workspaces: 1 } });
        store.updateDaemonDedicated("local", a.daemonId!, dedicated, "local");
        store.updateDaemonDedicated("local", b.daemonId!, dedicated, "local");
        const agent = store.createAgent({ name: "Explicit waiter", provider: "codex" });
        const task = store.createTask({ agentId: agent.id, prompt: "Explicit routing" });
        if (location !== "none") {
          let workspaceRuntime = location === "other" ? b : a;
          if (location === "foreign-tenant") {
            const tenant = store.createWorkspace({ name: "Foreign tenant", slug: "foreign-explicit" });
            workspaceRuntime = store.registerRuntime({
              name: "Foreign A", provider: "codex", daemonId: a.daemonId!, workspaceId: tenant.id,
              metadata: { runtime_workspaces: 1 },
            });
          }
          const workspace = store.runtimeWorkspaces.create(workspaceRuntime.id, { name: "Explicit files", root_path: "/local/explicit" });
          // Historical invalid bindings must fail the SQL guards too; creation
          // already rejects archived and foreign-tenant workspace references.
          mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_workspace_id = ? WHERE id = ?", [workspace.id, task.id]);
          if (location === "archived") {
            db!.run("UPDATE multiremi_runtime_workspaces SET archived_at = ? WHERE id = ?", [new Date().toISOString(), workspace.id]);
          }
        }
        const verdict = store.describeTaskPlacement(task.id).find((v) => v.runtimeId === a.id)!;
        const repair = deviceRoutingRepair({
          projectId: null, projectHasDevices: false, machineBound: false, dedicated,
          runtimeWorkspaceOnMachine: location === "local",
        }, "A");
        expect(verdict.routingOk).toBe(!dedicated || location === "local");
        expect(verdict.routingOk).toBe(repair === null);
        if (repair) expect(repair.actions).toEqual(["取消 A 的独享设置"]);
        const now = Date.now();
        ageTask(task.id, GRACE_MS, now);
        expect(() => store.refreshQueuedCapabilityWaitReasons(now)).not.toThrow();
        if (location === "local" || location === "other" || (location === "none" && !dedicated)) {
          expect(store.getTask(task.id)?.waitReason).toBeNull();
          expect(store.claimTask(location === "other" ? b.id : a.id)?.id).toBe(task.id);
        } else {
          expect(store.claimTask(a.id)).toBeNull();
          expect(store.claimTask(b.id)).toBeNull();
        }
      });
    }
  }

  it("clears stale device and placement waits for an explicit workspace on a dedicated owner", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "Owner", provider: "codex", daemonId: "explicit-clear", metadata: { runtime_workspaces: 1 } });
    store.updateDaemonDedicated("local", runtime.daemonId!, true, "local");
    const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Owned files", root_path: "/local/clear" });
    const agent = store.createAgent({ name: "Recovery", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, runtimeWorkspaceId: workspace.id, prompt: "Recover" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    for (const prefix of ["等待项目设备：", "等待任务落点："]) {
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET wait_reason = ? WHERE id = ?", [`${prefix}stale`, task.id]);
      expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 1, alerted: 0 });
      expect(store.getTask(task.id)?.waitReason).toBeNull();
    }
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });

  it("offers only Agent rebinding when a dedicated workspace owner already passes routing", () => {
    const store = createLocalStore();
    const owner = store.registerRuntime({ name: "Owner", provider: "codex", daemonId: "explicit-anchor", metadata: { runtime_workspaces: 1 } });
    const other = store.registerRuntime({ name: "Other", provider: "codex", daemonId: "explicit-bound", metadata: { runtime_workspaces: 1 } });
    store.updateDaemonDedicated("local", owner.daemonId!, true, "local");
    store.updateDaemonDedicated("local", other.daemonId!, true, "local");
    const workspace = store.runtimeWorkspaces.create(owner.id, { name: "Owned files", root_path: "/local/anchor" });
    const agent = store.createAgent({ name: "Bound elsewhere", provider: "codex", runtimeId: other.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Conflict" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_workspace_id = ? WHERE id = ?", [workspace.id, task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toStartWith("等待任务落点：");
    expect(reason).toContain(`remi agent update ${agent.id} --runtime ${owner.id}`);
    expect(reason).not.toContain("取消");
    expect(store.claimTask(owner.id)).toBeNull();
    store.updateAgent(agent.id, { runtimeId: owner.id });
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toBeNull();
    expect(store.claimTask(owner.id)?.id).toBe(task.id);
  });

  it("never offers redispatch for a frozen Chat even when it also has an Issue", () => {
    const reason = placementWaitReason({
      constraints: ["Agent 绑定 B", "任务钉住 A"],
      frozenRetry: true,
      frozenTask: true,
      agentBound: true,
      agentId: "agt_chat",
      agentBindingTarget: "A",
      agentBindingRuntimeId: "rt_a",
      chatSessionId: "cht_chat",
      redispatchTaskId: "tsk_chat",
    });
    expect(reason).not.toContain("redispatch");
    expect(reason).toContain("remi agent update agt_chat --runtime rt_a");
    expect(reason).toContain("remi turn get tsk_chat --input --output json");
    expect(reason).toContain("remi message send cht_chat --content-file");
  });
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
    const issue = createResponsibleTestIssue(store, { title: "Device issue", projectId: project.id, workspaceId: "local" });
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
    expect(store.getTask(task.id)?.waitReason).toContain("把 devbox-a 加回项目的设备绑定");
    expect(store.getTask(task.id)?.waitReason).not.toContain("取消");
    // The workspace data only exists on the devbox: keep waiting, don't move it.
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: devbox.id, status: "queued" });
  });

  it("explains a frozen retry that is never re-pooled", () => {
    const { store, devbox, agent, issue, parent, move } = deviceFixture();
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "frozen retry",
    });
    mutateExecutionFixture(db!, `UPDATE multiremi_turn_execution_records SET runtime_id = ?, session_id = 'sess_frozen', work_dir = '/work/frozen',
         attempt = 2, execution_fingerprint = 'frozen-fingerprint' WHERE id = ?`, [devbox.id, task.id]);
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
    const issue = createResponsibleTestIssue(store, { title: "Unregistered issue", projectId: project.id, workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "wait for its machine" });

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
    mutateExecutionFixture(db!, `UPDATE multiremi_turn_execution_records SET runtime_id = ?, attempt = 2, execution_fingerprint = 'frozen'
        WHERE id = ?`, ["rt_projectless_missing", task.id]);
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
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [a.id, second.id]);

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
    const issue = createResponsibleTestIssue(store, { title: "Lease-free issue", projectId: project.id, workspaceId: "local" });
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

  // MUL-449 ruling 2: the observer decides from the claim's own placement
  // predicate, so a conflict between two hard constraints is visible instead
  // of silently queuing forever.
  function conflictFixture(providers: { codex: string; other: string }) {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_cf_a", name: "A", provider: "codex", workspaceId: "local", daemonId: providers.codex,
    });
    const b = store.registerRuntime({
      id: "rt_cf_b", name: "B", provider: "codex", workspaceId: "local", daemonId: providers.other,
    });
    const agent = store.createAgent({ name: "Conflict agent", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Conflict project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: providers.codex });
    store.createProjectDevice(project.id, { daemonId: providers.other });
    const issue = createResponsibleTestIssue(store, { title: "Conflict issue", projectId: project.id, workspaceId: "local" });
    return { store, a, b, agent, project, issue };
  }

  it("explains a frozen retry that conflicts with the live Issue workspace", () => {
    const { store, a, b, agent, issue } = conflictFixture({ codex: "dev-cf-a", other: "dev-cf-b" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "frozen" });
    mutateExecutionFixture(db!, `UPDATE multiremi_turn_execution_records SET runtime_id = ?, attempt = 2, execution_fingerprint = 'frozen-fp' WHERE id = ?`, [a.id, task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    const reason = store.getTask(task.id)!.waitReason!;
    expect(reason).toContain("等待任务落点：");
    expect(reason).toContain("remi turn retry");
    // The frozen pin survives — the remedy is redispatch, not an automatic move.
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: a.id, attempt: 2 });
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();

    // The suggested remedy really resolves it: the replacement has no frozen
    // pin, so the workspace machine can take it.
    const retry=store.retryTurn(store.getTurnForAttempt(task.id)!.id,true);
    expect(store.claimTask(b.id)?.id).toBe(retry.current_attempt_id!);

  });

  it("reports a placement conflict between a registered Agent binding and an unregistered workspace machine", () => {
    const store = createLocalStore();
    const m = store.registerRuntime({
      id: "rt_mixed_m", name: "M", provider: "codex", workspaceId: "local", daemonId: "dev-mixed-m",
    });
    const agent = store.createAgent({ name: "Bound M", provider: "codex", workspaceId: "local", runtimeId: m.id });
    const project = store.createProject({ title: "Mixed placement", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Mixed issue", projectId: project.id, workspaceId: "local" });
    const workspace = (store as unknown as {
      runtimeWorkspaces: { create(runtimeId: string, input: { name: string; root_path: string }): { id: string } };
    }).runtimeWorkspaces.create(m.id, { name: "Unregistered U", root_path: "/tmp/mixed-u" });
    db!.run("UPDATE multiremi_runtime_workspaces SET daemon_id = ? WHERE id = ?", ["dev-mixed-u", workspace.id]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "M versus U" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_workspace_id = ? WHERE id = ?", [workspace.id, task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.describeTaskPlacement(task.id).every((verdict) => !verdict.placementOk)).toBe(true);
    expect(store.claimTask(m.id)).toBeNull();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toStartWith("等待任务落点：");
  });

  it("redispatches a frozen Issue through HTTP before rebinding its Agent", async () => {
    const { store, a, b, agent, issue } = conflictFixture({ codex: "dev-frozen-code-a", other: "dev-frozen-code-b" });
    const parent = store.createIssueSession(issue.id, { title: "Main", holdsWorkspace: true });
    const seed = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "seed" });
    expect(store.claimTask(a.id)?.id).toBe(seed.id);
    store.startTask(seed.id);
    store.completeTask(seed.id, { output: "ok", sessionId: "sess_frozen_code" });
    const side = store.createIssueSession(issue.id, {
      title: "Side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
    });
    store.updateAgent(agent.id, { runtimeId: b.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "frozen snapshot" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = 'frozen-code-fp' WHERE id = ?", [task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toStartWith("等待任务落点：");
    expect(reason).toContain("A");
    expect(reason).toContain("直接改绑会取消这条已冻结的任务");
    const command = reason.match(/remi turn retry ([a-zA-Z0-9_-]+) --cold --reason '([^']+)' --yes[\s\S]*?remi agent update ([a-zA-Z0-9_-]+) --runtime ([a-zA-Z0-9_-]+)/);
    expect(command).not.toBeNull();
    expect(command![1]).toBe(task.id);
    expect(command![3]).toBe(agent.id);
    expect(command![4]).toBe(a.id);
    const { response, replacement } = await redispatchAsSupervisor(store, task.id, command![2]!);
    expect(response.status).toBe(200);
    expect(replacement).not.toBeNull();
    expect(replacement!).toMatchObject({
      prompt: task.prompt, turn_id: store.getTurnForAttempt(task.id)!.id, issueSessionId: side.id,
      executionFingerprint: null,
    });
    store.updateAgent(agent.id, { runtimeId: a.id });
    expect(store.getTask(replacement!.id)?.status).not.toBe("cancelled");
    expect(store.describeTaskPlacement(replacement!.id).find((verdict) => verdict.runtimeId === a.id))
      .toMatchObject({ placementOk: true, routingOk: true });
    expect(store.claimTask(b.id)).toBeNull();
    expect(store.claimTask(a.id)?.id).toBe(replacement!.id);
  });

  it("rebinds and resends a frozen Chat request through the creator's HTTP routes", async () => {
    const store = createLocalStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "owner", name: "Owner", role: "owner" });
    const pat = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" };
    const a = store.registerRuntime({ id: "rt_chat_frozen_a", name: "A", provider: "codex", daemonId: "chat-frozen-a", ownerId: "alice" });
    const b = store.registerRuntime({ id: "rt_chat_frozen_b", name: "B", provider: "codex", daemonId: "chat-frozen-b", ownerId: "alice" });
    const agent = store.createAgent({ name: "Chat frozen", provider: "codex", runtimeId: b.id, ownerId: "alice" });
    const project = store.createProject({ title: "Chat directory", resources: [
      { resourceType: "local_directory", resourceRef: { local_path: "/abs/chat-frozen", daemon_id: "chat-frozen-a" } },
    ] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id, creatorId: "alice" });
    const original = store.sendChatMessage(chat.id, { body: "I can't retry\n\n  keep inner spaces  \nwith its last line" });
    const task = original.task;
    for (let index = 0; index < 65; index++) {
      store.sendMessage({session_id:chat.id,sender:{type:"member",id:store.listWorkspaceMembers("local").find(member=>member.userId==="alice")!.id},
        message_kind:"request",body_md:`later message ${index}`,to:{type:"none"},wake_requested:"now"});
    }
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = 'chat-frozen-fp' WHERE id = ?", [task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toContain("直接改绑会取消这条已冻结的任务");
    expect(reason).not.toContain("remi task redispatch");
    const command = reason.match(/remi agent update ([a-zA-Z0-9_-]+) --runtime ([a-zA-Z0-9_-]+)[\s\S]*?remi turn get ([a-zA-Z0-9_-]+) --input --output json[\s\S]*?remi message send ([a-zA-Z0-9_-]+) --content-file/);
    expect(command).not.toBeNull();
    expect(command![1]).toBe(agent.id);
    expect(command![2]).toBe(a.id);
    expect(command![3]).toBe(store.getTurnForAttempt(task.id)!.id);
    expect(command![4]).toBe(chat.id);
    expect(reason).not.toContain("--content '");

    const workspace = store.getWorkspace("local")!;
    store.updateWorkspace("local", { settings: { ...workspace.settings, organizer: { mode: "act" } } });
    const supervisor = store.createAgent({ name: "Organizer", provider: "claude", role: "supervisor" });
    store.setAgentSupervisor(supervisor.id, true);
    const patrol = createResponsibleTestIssue(store, { title: "Organizer patrol" });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "organize" });
    const supervisorToken = await store.createTaskAccessToken(supervisorTask, "owner");
    const denied = await app.request(turnApiPath(store, task.id, "/retry"), {
      method: "POST",
      headers: { Authorization: `Bearer ${supervisorToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cold: true }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("not your chat session"); // #6: conversation privacy rejects before Turn control.

    const rebound = await app.request(`/api/multiremi/agents/${command![1]}`, {
      method: "PATCH", headers, body: JSON.stringify({ runtime_id: command![2] }),
    });
    expect(rebound.status).toBe(200);
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    const originalMessage = store.listChatMessagesFromLog(chat.id)
      .find((message) => message.id === store.getTurnForAttempt(task.id)!.trigger_message_id);
    expect(originalMessage?.body).toBe(original.message.body);
    const resent = await app.request(`/api/sessions/${command![4]}/messages`, {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { content: originalMessage!.body }, { type: "agent", ref: store.getChatSession(command![4])!.agentId })),
    });
    expect(resent.status).toBe(200);
    const resentBody = await resent.json() as { turn_id: string; message: { id: string } };
    const replayed = store.getTask(sentTask(store, resentBody).id)!;
    expect(store.getChatMessage(resentBody.message.id)?.body).toBe(originalMessage!.body);
    expect(replayed.chatSessionId).toBe(task.chatSessionId);
    expect(replayed.prompt).toBe(task.prompt);
    expect(store.claimTask(b.id)).toBeNull();
    expect(store.claimTask(a.id)?.id).toBe(replayed.id);
  });

  it("warns that directly rebinding a frozen Chat Agent cancels its queued task", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_chat_cancel_a", name: "A", provider: "codex", daemonId: "chat-cancel-a" });
    const b = store.registerRuntime({ id: "rt_chat_cancel_b", name: "B", provider: "codex", daemonId: "chat-cancel-b" });
    const agent = store.createAgent({ name: "Chat direct rebind", provider: "codex", runtimeId: b.id });
    const project = store.createProject({ title: "Chat directory", resources: [
      { resourceType: "local_directory", resourceRef: { local_path: "/abs/chat-cancel", daemon_id: "chat-cancel-a" } },
    ] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "original Chat work" }).task;
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = 'chat-cancel-fp' WHERE id = ?", [task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toContain("直接改绑会取消这条已冻结的任务");
    store.updateAgent(agent.id, { runtimeId: a.id });
    expect(store.getTask(task.id)?.status).toBe("cancelled");
  });

  it("restores a frozen Chat Agent's refused Project binding without cancelling its task", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_chat_route_a", name: "A", provider: "codex", daemonId: "chat-route-a" });
    const b = store.registerRuntime({ id: "rt_chat_route_b", name: "B", provider: "codex", daemonId: "chat-route-b" });
    const agent = store.createAgent({ name: "Chat route", provider: "codex", runtimeId: a.id });
    const project = store.createProject({ title: "B only" });
    store.createProjectDevice(project.id, { daemonId: "chat-route-b" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "original work" }).task;
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = 'chat-route-fp' WHERE id = ?", [task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toStartWith("等待项目设备：");
    expect(store.getTask(task.id)?.waitReason).toContain("把 A 加回项目的设备绑定");
    expect(store.getTask(task.id)?.waitReason).not.toContain("取消");
    store.createProjectDevice(project.id, { daemonId: "chat-route-a" });
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(b.id)).toBeNull();
    expect(store.claimTask(a.id)?.id).toBe(task.id);
  });

  it("orders device restoration before rebinding an Agent to its data machine", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_rebind_rejected_a", name: "A", provider: "codex", daemonId: "rebind-rejected-a" });
    const b = store.registerRuntime({ id: "rt_rebind_rejected_b", name: "B", provider: "codex", daemonId: "rebind-rejected-b" });
    const agent = store.createAgent({ name: "Bound B", provider: "codex", runtimeId: b.id });
    const project = store.createProject({ title: "B only" });
    store.createProjectDevice(project.id, { daemonId: "rebind-rejected-b" });
    const issue = createResponsibleTestIssue(store, { title: "Snapshot A", projectId: project.id });
    const parent = store.createIssueSession(issue.id, { title: "Parent", holdsWorkspace: true });
    const seed = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "seed" });
    // A historical parent lane supplies the snapshot while Project routing now refuses A.
    db!.run("UPDATE multiremi_session_lanes SET runtime_id = ?, provider_session_id = 'seed-session' WHERE session_id = ? AND reader_type='agent' AND reader_id = ?", [a.id, parent.id, agent.id]);
    const side = store.createIssueSession(issue.id, { title: "Side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "work" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toContain("把 A 加回项目的设备绑定");
    expect(reason).toContain(`remi agent update ${agent.id} --runtime ${a.id}`);
    expect(reason.indexOf("加回项目的设备绑定")).toBeLessThan(reason.indexOf("remi agent update"));
    void seed;
  });

  it("rebinds an unfrozen Agent conflict through updateAgent without cancelling the task", () => {
    const { store, a, b, issue } = conflictFixture({ codex: "dev-unfrozen-a", other: "dev-unfrozen-b" });
    const agent = store.createAgent({ name: "Rebind", provider: "codex", runtimeId: b.id });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: a.id,
      rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [] });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    expect(store.getTask(task.id)?.waitReason).toContain(`remi agent update ${agent.id} --runtime ${a.id}`);
    expect(store.getTask(task.id)?.waitReason).not.toContain("已冻结");
    store.updateAgent(agent.id, { runtimeId: a.id });
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(a.id)?.id).toBe(task.id);
  });

  it("lists exactly the single actions that clear each device-routing refusal", () => {
    let combinations = 0;
    let impossible = 0;
    const qaCases: Record<string, string[]> = {};
    for (const hasProject of [false, true])
      for (const hasBindings of [false, true])
        for (const boundToA of [false, true])
          for (const dedicated of [false, true]) {
            combinations++;
            const coordinate = JSON.stringify({ hasProject, hasBindings, boundToA, dedicated });
            if (hasProject && !hasBindings && boundToA) {
              // A binding to A itself makes "project has no bindings" impossible.
              impossible++;
              continue;
            }
            const build = () => {
              const store = createLocalStore();
              const a = store.registerRuntime({ name: "A", provider: "codex", daemonId: "table-a" });
              const b = store.registerRuntime({ name: "B", provider: "codex", daemonId: "table-b" });
              const agent = store.createAgent({ name: "Route table", provider: "codex" });
              const project = hasProject ? store.createProject({ title: "Target" }) : null;
              if (project && hasBindings) store.createProjectDevice(project.id, { daemonId: boundToA ? "table-a" : "table-b" });
              if (dedicated) {
                const foreign = store.createProject({ title: "Foreign" });
                store.createProjectDevice(foreign.id, { daemonId: "table-a" });
                store.updateDaemonDedicated("local", "table-a", true, "local");
              }
              const chat = store.createChatSession({ agentId: agent.id, ...(project ? { projectId: project.id } : {}) });
              const task = store.sendChatMessage(chat.id, { body: "routing table request" }).task;
              mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ?, execution_fingerprint = 'routing-table-fp' WHERE id = ?", [a.id, task.id]);
              const now = Date.now();
              ageTask(task.id, GRACE_MS, now);
              store.refreshQueuedCapabilityWaitReasons(now);
              return { store, a, b, project, task, reason: store.getTask(task.id)?.waitReason ?? "" };
            };
            const baseline = build();
            const before = baseline.store.describeTaskPlacement(baseline.task.id).find((v) => v.runtimeId === baseline.a.id)!;
            const state = { projectId: baseline.project?.id ?? null, projectHasDevices: hasProject && hasBindings,
              machineBound: hasProject && hasBindings && boundToA, dedicated, runtimeWorkspaceOnMachine: false };
            const repair = deviceRoutingRepair(state, "A");
            expect(before.routingOk, coordinate).toBe(repair === null);
            if (repair) expect(baseline.reason, coordinate).toStartWith("等待项目设备：");
            else expect(baseline.reason, coordinate).not.toStartWith("等待项目设备：");
            const qaName = hasProject
              ? hasBindings && !boundToA ? dedicated ? "bound-B-dedicated" : "bound-B-shared"
                : !hasBindings && dedicated ? "unbound-dedicated" : null
              : dedicated && !hasBindings && !boundToA ? "projectless-dedicated" : null;
            if (qaName) qaCases[qaName] = repair?.actions.map((action) =>
              action.includes("加回") ? "add binding" : "remove dedicated") ?? [];
            for (const action of ["add", "remove"] as const) {
              const { store, a, b, project, task, reason } = build();
              if (action === "add" && project) {
                if (!hasBindings || !boundToA) store.createProjectDevice(project.id, { daemonId: "table-a" });
              }
              if (action === "remove") store.updateDaemonDedicated("local", "table-a", false, "local");
              const after = store.describeTaskPlacement(task.id).find((v) => v.runtimeId === a.id)!;
              const works = !before.routingOk && after.routingOk && store.claimTask(a.id)?.id === task.id;
              expect(works, `${coordinate}/${action}: ${reason}`).toBe(action === "add"
                ? reason.includes("加回项目的设备绑定")
                : /取消 .* 的独享设置/.test(reason));
              if (works) expect(store.claimTask(b.id)).toBeNull();
            }
          }
    expect(combinations).toBe(16);
    expect(impossible).toBe(2);
    expect(qaCases).toEqual({
      "bound-B-shared": ["add binding"],
      "bound-B-dedicated": ["add binding"],
      "unbound-dedicated": ["add binding", "remove dedicated"],
      "projectless-dedicated": ["remove dedicated"],
    });
  }, 120_000);

  it("executes placement remedies across Chat and Issue binding combinations", () => {
    const counts = new Map<string, number>();
    const alternatives = new Map<string, number>();
    const noMechanical: string[] = [];
    let cells = 0;
    for (const kind of ["chat", "issue", "chat-no-project"] as const)
      for (const frozen of [false, true])
        for (const binding of ["A", "B", "none"] as const)
          for (const dataOnA of [false, true])
            for (const devices of ["none", "A", "B", "AB"] as const)
              for (const dedicated of [false, true]) {
              if (kind === "chat-no-project" && (dataOnA || devices !== "none")) continue;
              for (const option of ["primary", "remove-dedicated"] as const) {
              if (option === "remove-dedicated" && (!dedicated || devices !== "none" || kind === "chat-no-project")) continue;
              const coordinate = `${kind}/${frozen ? "frozen" : "plain"}/${binding}/${dataOnA ? "data-A" : "no-data"}/${devices}/${dedicated ? "dedicated" : "shared"}`;
              if (option === "primary") cells++;
              const store = createLocalStore();
              const key = `${cells}_${option}`.replace(/-/g, "_");
              const a = store.registerRuntime({ id: `rt_matrix_a_${key}`, name: "A", provider: "codex", daemonId: `matrix-a-${key}` });
              const b = store.registerRuntime({ id: `rt_matrix_b_${key}`, name: "B", provider: "codex", daemonId: `matrix-b-${key}` });
              const agent = store.createAgent({ name: "Matrix", provider: "codex" });
              const project = kind === "chat-no-project" ? null : store.createProject({ title: "Matrix", resources: kind === "chat" && dataOnA
                ? [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/matrix", daemon_id: a.daemonId } }] : [] });
              if (project) store.createProjectDevice(project.id, { daemonId: a.daemonId! });
              let issue: ReturnType<typeof store.createIssue> | null = null;
              let issueSessionId: string | null = null;
              if (kind === "issue") {
                issue = createResponsibleTestIssue(store, { title: "Matrix issue", projectId: project!.id });
                if (dataOnA) {
                  const parent = store.createIssueSession(issue.id, { title: "Parent", holdsWorkspace: true });
                  const seed = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "seed" });
                  expect(store.claimTask(a.id)?.id, coordinate).toBe(seed.id);
                  store.startTask(seed.id);
                  store.completeTask(seed.id, { output: "ok", sessionId: `matrix-session-${cells}` });
                  issueSessionId = store.createIssueSession(issue.id, {
                    title: "Code", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
                  }).id;
                } else {
                  issueSessionId = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false }).id;
                }
              }
              if (project && (devices === "B" || devices === "none")) store.deleteProjectDevice(project.id, a.daemonId!);
              if (project && (devices === "B" || devices === "AB")) store.createProjectDevice(project.id, { daemonId: b.daemonId! });
              if (dedicated) {
                const foreign = store.createProject({ title: "Other Project" });
                store.createProjectDevice(foreign.id, { daemonId: a.daemonId! });
                store.updateDaemonDedicated("local", a.daemonId!, true, "local");
              }
              if (binding !== "none") store.updateAgent(agent.id, { runtimeId: binding === "A" ? a.id : b.id });
              const prompt = `original ${coordinate}`;
              const chat = kind !== "issue" ? store.createChatSession({ agentId: agent.id,
                ...(project ? { projectId: project.id } : {}) }) : null;
              const task = chat ? store.sendChatMessage(chat.id, { body: prompt }).task
                : store.createTask({ agentId: agent.id, issueId: issue!.id, issueSessionId: issueSessionId!, prompt });
              if (frozen) mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET execution_fingerprint = ? WHERE id = ?", [`fp-${cells}`, task.id]);
              const now = Date.now();
              ageTask(task.id, GRACE_MS, now);
              store.refreshQueuedCapabilityWaitReasons(now);
              const reason = store.getTask(task.id)?.waitReason ?? "";
              const offersBoth = reason.includes("加回项目的设备绑定") && reason.includes("取消")
                && reason.includes("独享设置");
              if (offersBoth) expect(dedicated && devices === "none" && project !== null, coordinate).toBe(true);
              if (option === "remove-dedicated" && !offersBoth) continue;
              const initiallyClaimable = store.describeTaskPlacement(task.id).some((verdict) => verdict.placementOk && verdict.routingOk);
              if (initiallyClaimable) {
                expect(reason, coordinate).not.toStartWith("等待任务落点：");
                expect(reason, coordinate).not.toStartWith("等待项目设备：");
                if (option === "primary") counts.set("already claimable", (counts.get("already claimable") ?? 0) + 1);
              } else if (reason.includes("让这些约束指向同一台机器") && !reason.includes("remi agent update")) {
                if (option === "primary") {
                  noMechanical.push(`${coordinate}: ${reason}`);
                  counts.set("no mechanical remedy", (counts.get("no mechanical remedy") ?? 0) + 1);
                }
                continue;
              } else {
                const addTarget = /把 ([^；，]+) 加回项目的设备绑定/.exec(reason)?.[1];
                const addDevice = Boolean(addTarget) && option === "primary";
                const removeDedicated = reason.includes("取消") && reason.includes("独享设置")
                  && (option === "remove-dedicated" || !addDevice);
                const rebind = reason.match(/remi agent update [a-zA-Z0-9_-]+ --runtime ([a-zA-Z0-9_-]+)/);
                const redispatch = reason.match(/remi turn retry ([a-zA-Z0-9_-]+) --cold/);
                const resend = reason.includes("remi message send");
                if (addDevice) store.createProjectDevice(project!.id, {
                  daemonId: addTarget === "B" || addTarget === b.daemonId ? b.daemonId! : a.daemonId!,
                });
                if (removeDedicated) store.updateDaemonDedicated("local", a.daemonId!, false, "local");
                let replacement = task;
                if (redispatch) {
                  expect(redispatch[1], coordinate).toBe(task.id);
                  const workspace = store.getWorkspace("local")!;
                  store.updateWorkspace("local", { settings: { ...workspace.settings, organizer: { mode: "act" } } });
                  const supervisor = store.createAgent({ name: "Supervisor", provider: "claude", role: "supervisor" });
                  store.setAgentSupervisor(supervisor.id, true);
                  const patrol = createResponsibleTestIssue(store, { title: "Patrol" });
                  const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "patrol" });
                  const retried=store.retryTurn(store.getTurnForAttempt(task.id)!.id,true);
                  replacement=store.getTask(retried.current_attempt_id!)!;
                  void supervisorTask;
                }
                if (rebind) store.updateAgent(agent.id, { runtimeId: rebind[1]! });
                if (resend) {
                  expect(chat, coordinate).not.toBeNull();
                  const original = store.listChatMessages(chat!.id).find((message) => message.id === store.getTurnForAttempt(task.id)!.trigger_message_id && message.role === "user");
                  expect(original, coordinate).toBeDefined();
                  replacement = store.sendChatMessage(chat!.id, { body: original!.body }).task;
                }
                const sequence = [addDevice && "add device", removeDedicated && "remove dedicated",
                  redispatch && "redispatch", rebind && "rebind", resend && "resend"].filter(Boolean).join(" + ");
                if (coordinate === "chat/frozen/B/data-A/B/shared") expect(sequence).toBe("add device + rebind + resend");
                if (coordinate === "issue/frozen/B/data-A/B/shared") expect(sequence).toBe("add device + redispatch + rebind");
                if (coordinate === "chat/frozen/A/data-A/B/shared") {
                  expect(sequence).toBe("add device");
                  expect(store.getTask(task.id)?.status).toBe("queued");
                }
                const tally = option === "primary" ? counts : alternatives;
                tally.set(sequence, (tally.get(sequence) ?? 0) + 1);
                expect(replacement.prompt, coordinate).toBe(prompt);
                if (dataOnA) {
                  expect(store.claimTask(b.id), coordinate).toBeNull();
                  expect(store.claimTask(a.id)?.id, coordinate).toBe(replacement.id);
                } else {
                  const claimed = store.claimTask(a.id) ?? store.claimTask(b.id);
                  expect(claimed?.id, coordinate).toBe(replacement.id);
                }
                continue;
              }
              const claimed = store.claimTask(a.id) ?? store.claimTask(b.id);
              expect(claimed?.id, coordinate).toBe(task.id);
              expect(claimed?.prompt, coordinate).toBe(prompt);
              }
            }
    expect(cells).toBe(204);
    expect(cells).toBe([...counts.values()].reduce((sum, count) => sum + count, 0));
    expect(noMechanical, noMechanical.join("\n")).toEqual([]);
    expect([...alternatives.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    console.log(`remedy matrix: ${cells} cells, primary=${JSON.stringify(Object.fromEntries(counts))}, alternatives=${JSON.stringify(Object.fromEntries(alternatives))}, no mechanical=${JSON.stringify(noMechanical)}`);
  }, 120_000);

  it("names conflicting data constraints as a fourth-tier remedy", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_data_conflict_a", name: "A", provider: "codex", daemonId: "data-conflict-a" });
    store.registerRuntime({ id: "rt_data_conflict_b", name: "B", provider: "codex", daemonId: "data-conflict-b" });
    const agent = store.createAgent({ name: "Data conflict", provider: "codex" });
    const project = store.createProject({ title: "Data conflict", resources: [
      { resourceType: "local_directory", resourceRef: { local_path: "/abs/on-b", daemon_id: "data-conflict-b" } },
    ] });
    const issue = createResponsibleTestIssue(store, { title: "Data conflict", projectId: project.id });
    const workspace = (store as unknown as {
      runtimeWorkspaces: { create(runtimeId: string, input: { name: string; root_path: string }): { id: string } };
    }).runtimeWorkspaces.create(a.id, { name: "Workspace on A", root_path: "/abs/on-a" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "data conflict" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_workspace_id = ? WHERE id = ?", [workspace.id, task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toStartWith("等待任务落点：");
    expect(reason).toContain("显式 Runtime 工作区在 data-conflict-a");
    expect(reason).toContain("本机目录在 data-conflict-b");
    expect(reason).toContain("互相冲突；让这些约束指向同一台机器");
    expect(reason).not.toContain("remi agent update");
  });


  it("explains an unfingerprinted retry pin that claim-time refresh cannot repool", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_retry_a", name: "A", provider: "codex", daemonId: "retry-a" });
    const b = store.registerRuntime({ id: "rt_retry_b", name: "B", provider: "codex", daemonId: "retry-b" });
    const agent = store.createAgent({ name: "Retry", provider: "codex" });
    const project = store.createProject({ title: "B only" });
    store.createProjectDevice(project.id, { daemonId: "retry-b" });
    store.updateDaemonDedicated("local", "retry-a", true, "local");
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "retry" }).task;
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ?, attempt = 2, execution_fingerprint = NULL WHERE id = ?", [a.id, task.id]);
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: a.id });
    const reason = store.getTask(task.id)?.waitReason ?? "";
    expect(reason).toStartWith("等待项目设备：");
    expect(reason).toContain("重试钉机");
    expect(reason).not.toContain("冻结重试");
  });

  it("keeps registered multi-alias workspace placement out of the daemon fallback", () => {
    const store = createLocalStore();
    const codex = store.registerRuntime({
      id: "rt_alias_codex", name: "registered", provider: "codex", daemonId: "alias-machine",
    });
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Multi alias" });
    const issue = createResponsibleTestIssue(store, { title: "Multi alias", projectId: project.id });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: codex.id,
      rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [] });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(task.id)?.waitReason).toStartWith("等待任务落点：");
  });

  it("uses the same repool predicate in SQL and the hard-pin classifier", () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Predicate", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "predicate" });
    for (const [attempt, fingerprint] of [[1, null], [2, null], [1, "fp"], [2, "fp"]] as const) {
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET attempt = ?, execution_fingerprint = ? WHERE id = ?", [attempt, fingerprint, task.id]);
      const sqlAllows = db!.query(
        `SELECT 1 AS eligible FROM multiremi_turn_execution_records t WHERE t.id = ? AND ${REPOOLABLE_QUEUED_TASK_SQL}`,
      ).get(task.id) !== null;
      expect(canRepoolQueuedTaskPin({ attempt, execution_fingerprint: fingerprint })).toBe(sqlAllows);
    }
  });

  it("probes a queued batch once per Runtime rather than once per task", () => {
    const store = createLocalStore();
    const runtimes = Array.from({ length: 4 }, (_, index) => store.registerRuntime({
      id: `rt_batch_${index}`, name: `batch ${index}`, provider: "codex",
      daemonId: `dev-batch-${index}`,
    }));
    const agent = store.createAgent({ name: "Batch", provider: "codex", runtimeId: runtimes[0]!.id });
    const project = store.createProject({ title: "Batch" });
    const issue = createResponsibleTestIssue(store, { title: "Batch", projectId: project.id });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtimes[1]!.id,
      rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [] });
    const now = Date.now();
    for (let index = 0; index < 12; index++) {
      // #3: distinct Sessions retain twelve pending Turns instead of merging a single lane.
      const batchIssue=createResponsibleTestIssue(store, {title:`Batch ${index}`,projectId:project.id});
      store.reportIssueWorkspace({issueId:batchIssue.id,runtimeId:runtimes[1]!.id,rootPath:`/tmp/${batchIssue.key}`,branchName:`agent/${batchIssue.key}`,status:"ready",repos:[]});
      const task = store.createTask({ agentId: agent.id, issueId: batchIssue.id, prompt: `batch ${index}` });
      ageTask(task.id, GRACE_MS, now);
    }
    const query = spyOn(db!, "query");
    try {
      expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(12);
      const placementQueries = query.mock.calls.filter(([sql]) => String(sql).includes("AS placement_ok"));
      expect(placementQueries).toHaveLength(runtimes.length);
    } finally {
      query.mockRestore();
    }
  });

  it("explains an Agent-bound Runtime that conflicts with the live Issue workspace", () => {
    const { store, a, b, project, issue } = conflictFixture({ codex: "dev-cf-a", other: "dev-cf-b" });
    // Bind the Agent to the machine that does NOT hold the workspace.
    const bound = store.createAgent({
      name: "Bound elsewhere", provider: "codex", workspaceId: "local", runtimeId: a.id,
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const task = store.createTask({ agentId: bound.id, issueId: issue.id, prompt: "agent conflict" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    const reason = store.getTask(task.id)!.waitReason!;
    expect(reason).toContain("等待任务落点：");
    expect(reason).toContain("Agent 绑定");
    expect(reason).toContain(`remi agent update ${bound.id} --runtime ${b.id}`);
    // An Agent binding is configuration: it is never re-pooled automatically.
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();
    void project;
  });

  it("explains a workspace whose Runtime is gone without blaming the device binding", () => {
    const { store, a, b, agent, issue } = conflictFixture({ codex: "dev-cf-a", other: "dev-cf-b" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    // ON DELETE SET NULL: the Runtime row is gone but the workspace row remains.
    db!.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issue.id]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "orphan" });
    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    const reason = store.getTask(task.id)!.waitReason!;
    expect(reason).toContain("等待任务落点：");
    expect(reason).toContain("失去了所属 Runtime");
    // Pointing the reader at the Project binding would be wrong: no binding can
    // satisfy a workspace that names no machine.
    expect(reason).not.toContain("设备绑定");
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();
  });

  it("stays silent for a legacy daemon alias that can still claim the task", () => {
    const store = createLocalStore();
    const old = store.registerRuntime({
      id: "rt_lg_old", name: "Old codex", provider: "codex", workspaceId: "local", daemonId: "daemon-old",
    });
    const claude = store.registerRuntime({
      id: "rt_lg_claude", name: "Claude", provider: "claude", workspaceId: "local", daemonId: "daemon-new",
    });
    db!.run("UPDATE multiremi_runtimes SET legacy_daemon_id = 'daemon-old' WHERE id = ?", [claude.id]);
    const agent = store.createAgent({ name: "Legacy alias", provider: "claude", workspaceId: "local" });
    const project = store.createProject({ title: "Legacy project", workspaceId: "local" });
    // The Project only knows the NEW daemon name, but the sibling Runtime
    // carries the workspace's old daemon as a legacy alias, so it can claim.
    store.createProjectDevice(project.id, { daemonId: "daemon-new" });
    const issue = createResponsibleTestIssue(store, { title: "Legacy issue", projectId: project.id, workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: old.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "legacy" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [claude.id, task.id]);

    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    // A claimable machine exists, so the observer must write nothing at all.
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(task.id)?.waitReason).toBeNull();
    expect(store.claimTask(claude.id)?.id).toBe(task.id);
  });

  it("explains a code-snapshot conflict without offering redispatch", () => {
    const { store, a, b, agent, issue } = conflictFixture({ codex: "dev-cf-a", other: "dev-cf-b" });
    const parent = store.createIssueSession(issue.id, { title: "Main", holdsWorkspace: true });
    // The parent lane must exist on a Runtime before a with_code side session
    // can snapshot from it.
    const seed = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: parent.id, prompt: "seed" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: a.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(a.id)?.id).toBe(seed.id);
    store.startTask(seed.id);
    store.completeTask(seed.id, { output: "ok", sessionId: "sess_snap" });

    // The snapshot is taken on A; the Issue workspace then moves to B.
    const side = store.createIssueSession(issue.id, {
      title: "Side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id, runtimeId: a.id, ...readyArchiveBinding(store, issue.id, a.id),
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "snapshot",
    });
    expect(store.getTask(task.id)?.runtimeId).toBe(a.id);

    const now = Date.now();
    ageTask(task.id, GRACE_MS, now);
    store.refreshQueuedCapabilityWaitReasons(now);
    const reason = store.getTask(task.id)?.waitReason ?? "";
    // `redispatch` re-derives the same snapshot pin, so it may only be offered
    // for frozen retries.
    expect(reason).not.toContain("redispatch");
    void seed;
  });

  it("does not overwrite unrelated reasons or nonqueued task state", () => {
    const { store, agent, task, now, fail } = fixture();
    const directory = store.createTask({ agentId: agent.id, prompt: "Directory lock" });
    const human = store.createTask({ agentId: agent.id, prompt: "Human reply" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET wait_reason = ? WHERE id = ?", ["Existing queue dependency", task.id]);
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET status = 'waiting_local_directory', wait_reason = ? WHERE id = ?", ["/tmp/held-worktree", directory.id]);
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET status = 'awaiting_human', wait_reason = ? WHERE id = ?", ["Approval needed", human.id]);
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
