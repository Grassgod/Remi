import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    id: "workspace-origin", name: "Workspace origin", provider: "codex", daemonId: "workspace-host",
    workspaceId: "local", metadata: { runtime_workspaces: 1, codex_profiles: 1 }, maxConcurrency: 4,
  });
  const profile = store.setRuntimeCodexProfile(runtime.id, {
    name: "workspace-upstream", base_url: "https://workspace.example/v1", model: "old-model",
    auth_mode: "env", env_key: "REMI_CODEX_WORKSPACE_KEY",
  })!;
  store.updateRuntimeModels(runtime.id, [{ id: "old-model", label: "Old", provider: "codex", default: true,
    thinking: { status: "supported", supportedLevels: [{ value: "high", label: "high" }] } }], profile);
  const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Persistent files", root_path: "/local/work" });
  const agent = store.createAgent({ name: "Workspace worker", provider: "codex", model: "old-model", thinkingLevel: "high", maxConcurrentTasks: 4 });
  const task = store.createTask({ agentId: agent.id, runtimeWorkspaceId: workspace.id, prompt: "Keep files and upstream", maxAttempts: 2 });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  store.pinTaskSession(task.id, "old-native-session", "/local/work");
  store.failTask(task.id, { error: "lost worker", failureReason: "runtime_recovery" });
  const retry = store.listTasks().find(t => t.parentTaskId === task.id)!;
  expect(retry).toBeDefined();
  return { store, runtime, profile, workspace, agent, task, retry };
}

function origin(taskId: string) {
  return (db!.query("SELECT execution_runtime_id FROM multiremi_tasks WHERE id = ?").get(taskId) as { execution_runtime_id: string }).execution_runtime_id;
}

describe("persistent workspace and frozen retry integration", () => {
  it("keeps both bindings through standalone retry and selects its frozen model independently", () => {
    const { store, runtime, workspace, agent, profile, task, retry } = fixture();
    expect(retry).toMatchObject({ runtimeWorkspaceId: workspace.id, sessionId: null, workDir: null, codexProfile: profile });
    expect(origin(task.id)).toBe(runtime.id);
    expect(origin(retry.id)).toBe(runtime.id);
    store.updateAgent(agent.id, { model: "new-model" });
    const current = store.createTask({ agentId: agent.id, runtimeWorkspaceId: workspace.id, prompt: "New selection", priority: 100 });
    const other = store.registerRuntime({ name: "Another machine", provider: "codex", daemonId: "another-host", workspaceId: "local", metadata: { runtime_workspaces: 1, codex_profiles: 1 } });
    expect(store.claimTask(other.id)).toBeNull();
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(retry.id);
    expect(claimed.runtimeWorkspace?.id).toBe(workspace.id);
    expect(claimed.codexProfile).toEqual(profile);
    const peer = store.createAgent({ name: "Peer", provider: "codex" });
    const peerTask = store.createTask({ agentId: peer.id, runtimeWorkspaceId: workspace.id, prompt: "Same files" });
    expect(store.getTaskQueueBlocker(peerTask.id)?.taskId).toBe(retry.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.cancelTask(retry.id);
    expect(store.claimTask(runtime.id)?.id).toBe(peerTask.id);
    expect(store.getTask(current.id)?.status).toBe("queued");
  });

  it("rechecks workspace protocol on stale dispatch without changing the frozen origin", () => {
    const { store, runtime, workspace, retry } = fixture();
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [new Date(Date.now() - 120_000).toISOString(), retry.id]);
    store.registerRuntime({ id: runtime.id, name: runtime.name, provider: "codex", daemonId: runtime.daemonId!, workspaceId: "local", metadata: { codex_profiles: 1 } });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(retry.id)).toMatchObject({ status: "queued", runtimeWorkspaceId: workspace.id });
    expect(origin(retry.id)).toBe(runtime.id);
    store.registerRuntime({ id: runtime.id, name: runtime.name, provider: "codex", daemonId: runtime.daemonId!, workspaceId: "local", metadata: { codex_profiles: 1, runtime_workspaces: 1 } });
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it("retains the directory and reports the frozen source loss after retirement", () => {
    const { store, runtime, workspace, profile, retry } = fixture();
    const plan = store.getDaemonRetirementPlan("local", runtime.daemonId!);
    expect(plan.canRetire).toBe(true);
    expect(store.retireDaemon("local", runtime.daemonId!, plan.snapshot, "local").status).toBe("retired");
    store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
    expect(store.getTask(retry.id)).toMatchObject({
      status: "queued", runtimeId: null, runtimeWorkspaceId: workspace.id, codexProfile: profile,
      waitReason: expect.stringContaining("来源 Runtime 已退役或不存在"),
    });
    expect(origin(retry.id)).toBe(runtime.id);
    expect(store.runtimeWorkspaces.get(workspace.id)?.rootPath).toBe("/local/work");
  });
});
