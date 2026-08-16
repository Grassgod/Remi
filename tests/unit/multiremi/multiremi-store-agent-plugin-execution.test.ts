import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function importPlugin(store: ReturnType<typeof createStore>, version = "1.0.0") {
  return store.importAgentPlugin({
    provider: "claude",
    manifest: { name: "execution-proof", version },
    files: [{ path: "skills/execution-proof/SKILL.md", content: `# ${version}\n` }],
  });
}

describe("Multiremi store - Agent Plugin execution snapshots", () => {
  it("fails closed when a daemon downgrades its Plugin protocol", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_protocol_downgrade",
      name: "Plugin protocol runtime",
      provider: "claude",
      daemonId: "daemon-plugin-protocol",
      workspaceId: "local",
      metadata: { agent_plugin_protocol: 1 },
    });
    const agent = store.createAgent({ name: "Protocol worker", provider: "claude" });
    const plugin = importPlugin(store);
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
      retryGeneration: 0,
    });

    store.heartbeatRuntime(runtime.id, { agentPluginProtocol: 0 });
    expect(store.listAgentPluginRuntimeStates({ runtimeId: runtime.id })[0]).toMatchObject({
      status: "setup_required",
      retryGeneration: 1,
      observedDigest: null,
      lastErrorCode: "daemon_upgrade_required",
    });
    expect(() => store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
      retryGeneration: 0,
    })).toThrow("Upgrade the Multiremi daemon");

    const task = store.createTask({ agentId: agent.id, prompt: "must not run without Plugin support" });
    db!.run(
      `UPDATE multiremi_agent_plugin_runtime_states
       SET status = 'ready', observed_digest = ?, last_error_code = NULL, last_error = NULL
       WHERE runtime_id = ? AND plugin_version_id = ?`,
      [plugin.activeVersion!.artifactDigest, runtime.id, plugin.activeVersionId],
    );
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("waits for exact Runtime readiness and freezes bindings in the claim transaction", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_claim",
      name: "Plugin claim runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Plugin worker", provider: "claude" });
    const plugin = importPlugin(store);
    const binding = store.createAgentPluginBinding(agent.id, {
      pluginId: plugin.id,
      config: { scope: "docs" },
    });
    const task = store.createTask({ agentId: agent.id, prompt: "prove the plugin" });

    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({
      pluginSnapshot: [],
      executionFingerprint: null,
      status: "queued",
    });

    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(task.id);
    expect(claimed.executionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(claimed.pluginSnapshot).toEqual([{
      bindingId: binding.id,
      pluginId: plugin.id,
      versionId: plugin.activeVersionId!,
      name: "execution-proof",
      provider: "claude",
      version: "1.0.0",
      digest: plugin.activeVersion!.artifactDigest,
      artifactUrl: `/api/daemon/agent-plugin-artifacts/${plugin.activeVersion!.artifactDigest}`,
      sourceRevision: null,
      config: { scope: "docs" },
      connectionId: null,
    }]);

    const frozenFingerprint = claimed.executionFingerprint;
    store.updateAgentPluginBinding(agent.id, binding.id, { config: { scope: "sheets" } });
    expect(store.getTask(task.id)).toMatchObject({
      executionFingerprint: frozenFingerprint,
      pluginSnapshot: [{ config: { scope: "docs" } }],
    });
  });

  it("keeps infrastructure retries on the old version while manual work resolves the new active version", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_retry_snapshot",
      name: "Plugin retry runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Plugin retry worker", provider: "claude" });
    const plugin = importPlugin(store);
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });

    const issue = store.createIssue({ title: "old version run", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "run v1" });
    const claimed = store.claimTask(runtime.id)!;
    store.startTask(task.id);

    const candidate = store.createAgentPluginVersion(plugin.id, {
      manifest: { name: "execution-proof", version: "2.0.0" },
      files: [{ path: "skills/execution-proof/SKILL.md", content: "# 2.0.0\n" }],
    });
    store.reportAgentPluginRuntimeState(runtime.id, candidate.id, {
      status: "ready",
      observedDigest: candidate.artifactDigest,
    });
    store.activateAgentPluginVersion(plugin.id, candidate.id);

    store.failTask(task.id, { error: "runtime went away", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((entry) => entry.parentTaskId === task.id)!;
    expect(retry).toMatchObject({
      executionFingerprint: claimed.executionFingerprint,
      pluginSnapshot: [{ versionId: plugin.activeVersionId, version: "1.0.0" }],
    });
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins.map((entry) => entry.versionId).sort())
      .toEqual([plugin.activeVersionId!, candidate.id].sort());
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);

    // A user-created task is not a retry and therefore resolves the Agent's
    // current active Plugin only when this fresh task is claimed.
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "recovered" });
    const current = store.createTask({ agentId: agent.id, prompt: "run current config" });
    const currentClaim = store.claimTask(runtime.id)!;
    expect(currentClaim.id).toBe(current.id);
    expect(currentClaim.pluginSnapshot).toMatchObject([{ versionId: candidate.id, version: "2.0.0" }]);
    expect(currentClaim.executionFingerprint).not.toBe(claimed.executionFingerprint);
  });

  it("keeps an empty frozen retry independent from plugins bound later", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_empty_plugin_retry",
      name: "Empty Plugin retry runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Empty Plugin retry worker", provider: "claude" });
    const issue = store.createIssue({ title: "Retry without Plugins", workspaceId: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      prompt: "run without plugins",
      maxAttempts: 2,
    });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.pluginSnapshot).toEqual([]);
    expect(claimed.executionFingerprint).toMatch(/^[0-9a-f]{64}$/);

    store.startTask(task.id);
    store.failTask(task.id, { error: "runtime went away", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((entry) => entry.parentTaskId === task.id)!;
    expect(retry).toMatchObject({
      pluginSnapshot: [],
      executionFingerprint: claimed.executionFingerprint,
      status: "queued",
    });

    const plugin = importPlugin(store);
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    expect(store.listAgentPluginRuntimeStates({ runtimeId: runtime.id })[0]?.status).not.toBe("ready");
    expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  });

  it("starts a fresh provider session when an Agent Plugin binding changes", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_session_fingerprint",
      name: "Plugin session runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Plugin chat worker", provider: "claude" });
    const plugin = importPlugin(store);
    const binding = store.createAgentPluginBinding(agent.id, {
      pluginId: plugin.id,
      config: { space: "product" },
    });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });

    const chat = store.createChatSession({ agentId: agent.id, title: "Plugin session" });
    const first = store.sendChatMessage(chat.id, { body: "Read product docs" }).task;
    const firstClaim = store.claimTask(runtime.id)!;
    expect(firstClaim.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, {
      output: "done",
      sessionId: "provider-session-before-plugin-change",
    });
    expect(store.getChatSession(chat.id)).toMatchObject({
      sessionId: "provider-session-before-plugin-change",
      sessionExecutionFingerprint: firstClaim.executionFingerprint,
    });

    store.updateAgentPluginBinding(agent.id, binding.id, {
      config: { space: "engineering" },
    });
    const second = store.sendChatMessage(chat.id, { body: "Read engineering docs" }).task;
    expect(second.sessionId).toBeNull();
    const secondClaim = store.claimTask(runtime.id)!;
    expect(secondClaim.id).toBe(second.id);
    expect(secondClaim.executionFingerprint).not.toBe(firstClaim.executionFingerprint);
    expect(secondClaim.pluginSnapshot).toMatchObject([{ config: { space: "engineering" } }]);
  });

  it("cancels an unstarted frozen retry when the Agent provider changes", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_provider_drift",
      name: "Plugin provider drift runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Provider drift worker", provider: "claude" });
    const plugin = importPlugin(store);
    const binding = store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });

    const issue = store.createIssue({ title: "provider drift", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "run once" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.failTask(task.id, { error: "runtime offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((entry) => entry.parentTaskId === task.id)!;
    expect(retry).toMatchObject({ status: "queued", provider: "claude" });

    store.updateAgentPluginBinding(agent.id, binding.id, { enabled: false });
    store.updateAgent(agent.id, { provider: "codex" });
    expect(store.getTask(retry.id)?.status).toBe("cancelled");
  });
});
