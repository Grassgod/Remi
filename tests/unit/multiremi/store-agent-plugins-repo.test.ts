import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function claudePluginInput(version = "1.0.0", content = "# Lark\n") {
  return {
    provider: "claude" as const,
    name: "Lark for Claude",
    manifest: {
      version,
      name: "lark-for-claude",
      description: "Lark tools for Claude",
    },
    files: [
      { path: "skills/lark-doc/SKILL.md", content },
      { path: "commands/login.md", content: "Login" },
    ],
    sourceType: "git" as const,
    sourceUrl: "https://example.com/lark-plugin.git",
    sourceSubdir: "plugins/lark",
    sourceRevision: `commit-${version}`,
  };
}

describe("AgentPluginsRepo", () => {
  it("imports provider-native immutable versions and returns the exact canonical artifact", () => {
    const store = createStore();
    const plugin = store.importAgentPlugin(claudePluginInput());

    expect(plugin.provider).toBe("claude");
    expect(plugin.sourceSubdir).toBe("plugins/lark");
    expect(plugin.activeVersion?.version).toBe("1.0.0");
    expect(plugin.candidateVersion).toBeNull();
    expect(plugin.activeVersion?.manifestPath).toBe(".claude-plugin/plugin.json");
    expect(plugin.activeVersion?.files.map((file) => file.path)).toEqual([
      ".claude-plugin/plugin.json",
      "commands/login.md",
      "skills/lark-doc/SKILL.md",
    ]);
    expect(plugin.activeVersion?.files.every((file) => file.content === undefined)).toBe(true);

    const digest = plugin.activeVersion!.artifactDigest;
    const artifact = store.getAgentPluginArtifactByDigest(digest)!;
    expect(createHash("sha256").update(artifact.artifactJson).digest("hex")).toBe(digest);
    expect(artifact.artifact).toMatchObject({
      provider: "claude",
      manifestPath: ".claude-plugin/plugin.json",
    });

    const idempotent = store.importAgentPlugin(claudePluginInput());
    expect(idempotent.id).toBe(plugin.id);
    expect(store.listAgentPluginVersions(plugin.id)).toHaveLength(1);

    expect(() => store.importAgentPlugin(claudePluginInput("1.0.0", "changed"))).toThrow(
      "already exists with a different artifact",
    );

    const candidate = store.createAgentPluginVersion(plugin.id, {
      ...claudePluginInput("1.1.0").manifest,
      manifest: claudePluginInput("1.1.0").manifest,
      files: claudePluginInput("1.1.0").files,
      sourceRevision: "commit-1.1.0",
    });
    const updated = store.getAgentPlugin(plugin.id)!;
    expect(candidate.version).toBe("1.1.0");
    expect(updated.activeVersion?.version).toBe("1.0.0");
    expect(updated.candidateVersion?.version).toBe("1.1.0");
  });

  it("validates provider manifests and safe artifact paths", () => {
    const store = createStore();
    expect(() => store.importAgentPlugin({
      provider: "codex",
      manifestPath: ".claude-plugin/plugin.json",
      manifest: { name: "wrong", version: "1.0.0" },
    })).toThrow("codex plugins require .codex-plugin/plugin.json");
    expect(() => store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "unsafe", version: "1.0.0" },
      files: [{ path: "../secret", content: "no" }],
    })).toThrow("invalid plugin file path");
    expect(() => store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "not-semver", version: "main" },
    })).toThrow("valid SemVer");
    expect(() => store.importAgentPlugin({
      provider: "codex",
      manifest: { name: "missing-version" },
    })).toThrow("must declare a version");
  });

  it("derives stable Claude versions when the native manifest omits one", () => {
    const store = createStore();
    const local = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "local-version" },
      files: [{ path: "skills/local/SKILL.md", content: "# Local\n" }],
    });
    expect(local.activeVersion?.version).toMatch(/^0\.0\.0\+local\.[0-9a-f]{12}$/);

    const git = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "git-version" },
      sourceType: "git",
      sourceRevision: "1234567890abcdef1234567890abcdef12345678",
    });
    expect(git.activeVersion?.version).toBe("0.0.0+git.1234567890ab");
  });

  it("enforces provider-specific bindings and creates a stable task snapshot", () => {
    const store = createStore();
    const claude = store.createAgent({ name: "Claude", provider: "claude" });
    const codex = store.createAgent({ name: "Codex", provider: "codex" });
    const plugin = store.importAgentPlugin(claudePluginInput());

    expect(() => store.createAgentPluginBinding(codex.id, { pluginId: plugin.id })).toThrow(
      "claude plugin cannot be bound to codex agent",
    );

    const binding = store.createAgentPluginBinding(claude.id, {
      pluginId: plugin.id,
      connectionId: "conn_lark_owner",
      config: { domain: "docs" },
    });
    const snapshot = store.resolveAgentPluginSnapshot(claude.id);
    expect(snapshot).toEqual([{
      bindingId: binding.id,
      pluginId: plugin.id,
      versionId: plugin.activeVersionId!,
      name: "Lark for Claude",
      provider: "claude",
      version: "1.0.0",
      digest: plugin.activeVersion!.artifactDigest,
      artifactUrl: `/api/daemon/agent-plugin-artifacts/${plugin.activeVersion!.artifactDigest}`,
      sourceRevision: "commit-1.0.0",
      config: { domain: "docs" },
      connectionId: "conn_lark_owner",
    }]);

    const before = store.getAgentPluginCapabilityRevision(claude.id);
    store.updateAgentPluginBinding(claude.id, binding.id, { config: { domain: "sheets" } });
    expect(store.getAgentPluginCapabilityRevision(claude.id)).not.toBe(before);
  });

  it("converges every provider-compatible workspace runtime, reports observed state and consumes manual retries", () => {
    const store = createStore();
    const claude = store.createAgent({ name: "Claude", provider: "claude" });
    const plugin = store.importAgentPlugin(claudePluginInput());
    const runtimeA = store.registerRuntime({ id: "rt_plugin_a", name: "Runtime A", provider: "claude", workspaceId: "local" });
    const runtimeB = store.registerRuntime({ id: "rt_plugin_b", name: "Runtime B", provider: "claude", workspaceId: "local" });
    const anyRuntime = store.registerRuntime({
      id: "rt_plugin_any",
      name: "Any Runtime",
      provider: "any",
      workspaceId: "local",
    });
    const incompatibleRuntime = store.registerRuntime({
      id: "rt_plugin_codex",
      name: "Codex Runtime",
      provider: "codex",
      workspaceId: "local",
    });
    store.createAgentPluginBinding(claude.id, { pluginId: plugin.id });

    const desiredA = store.getRuntimeAgentPluginDesiredSnapshot(runtimeA.id);
    const desiredB = store.getRuntimeAgentPluginDesiredSnapshot(runtimeB.id);
    const desiredAny = store.getRuntimeAgentPluginDesiredSnapshot(anyRuntime.id);
    expect(desiredA.plugins.map((item) => item.versionId)).toEqual([plugin.activeVersionId!]);
    expect(desiredB.plugins.map((item) => item.versionId)).toEqual([plugin.activeVersionId!]);
    expect(desiredAny.plugins.map((item) => item.versionId)).toEqual([plugin.activeVersionId!]);
    expect(store.getRuntimeAgentPluginDesiredSnapshot(incompatibleRuntime.id).plugins).toEqual([]);
    expect(desiredA.plugins[0]!.retryGeneration).toBe(0);
    expect(store.runtimeHasReadyAgentPlugins(runtimeA.id, claude.id)).toBe(false);

    const digest = plugin.activeVersion!.artifactDigest;
    expect(() => store.reportAgentPluginRuntimeState(runtimeA.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: "0".repeat(64),
    })).toThrow("does not match desired digest");

    store.reportAgentPluginRuntimeState(runtimeA.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: digest,
    });
    store.reportAgentPluginRuntimeState(runtimeB.id, plugin.activeVersionId!, {
      status: "setup_required",
      lastErrorCode: "dependency_missing",
      lastError: "lark-cli missing",
      nextRetryAt: "2026-08-14T12:00:00.000Z",
    });
    const setupState = store.listAgentPluginRuntimeStates({ pluginId: plugin.id })
      .find((state) => state.runtimeId === runtimeB.id)!;
    expect(setupState).toMatchObject({
      status: "setup_required",
      retryCount: 1,
      nextRetryAt: "2026-08-14T12:00:00.000Z",
    });

    const retried = store.retryAgentPluginRuntime(plugin.id, runtimeB.id);
    expect(retried[0]).toMatchObject({ status: "pending", retryGeneration: 1, nextRetryAt: null });
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtimeB.id).plugins[0]).toMatchObject({
      status: "pending",
      retryGeneration: 1,
    });

    store.reportAgentPluginRuntimeState(runtimeB.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: digest,
    });
    store.reportAgentPluginRuntimeState(anyRuntime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: digest,
    });
    expect(store.runtimeHasReadyAgentPlugins(runtimeA.id, claude.id)).toBe(true);
    expect(store.runtimeHasReadyAgentPlugins(runtimeB.id, claude.id)).toBe(true);
    expect(store.runtimeHasReadyAgentPlugins(anyRuntime.id, claude.id)).toBe(true);
    expect(store.getAgentPlugin(plugin.id)?.runtimeSummary).toMatchObject({ desired: 3, ready: 3, offline: 0 });
    expect(store.listAgentPluginRuntimeStates({
      runtimeId: incompatibleRuntime.id,
      includeHistorical: true,
    })).toEqual([]);
  });

  it("preflights candidates before activation and keeps exact versions rollback-safe", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const runtime = store.registerRuntime({ id: "rt_plugin_update", name: "Runtime", provider: "claude", workspaceId: "local" });
    const anyRuntime = store.registerRuntime({
      id: "rt_plugin_update_any",
      name: "Any Runtime",
      provider: "any",
      workspaceId: "local",
    });
    store.registerRuntime({ id: "rt_plugin_update_codex", name: "Codex Runtime", provider: "codex", workspaceId: "local" });
    const plugin = store.importAgentPlugin(claudePluginInput());
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    store.reportAgentPluginRuntimeState(anyRuntime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });

    const candidate = store.createAgentPluginVersion(plugin.id, {
      manifest: claudePluginInput("2.0.0").manifest,
      files: claudePluginInput("2.0.0").files,
      sourceRevision: "commit-2.0.0",
    });
    expect(() => store.activateAgentPluginVersion(plugin.id, candidate.id)).toThrow("not ready on 2 online runtime");

    store.reportAgentPluginRuntimeState(runtime.id, candidate.id, {
      status: "ready",
      observedDigest: candidate.artifactDigest,
    });
    expect(() => store.activateAgentPluginVersion(plugin.id, candidate.id)).toThrow("not ready on 1 online runtime");
    store.reportAgentPluginRuntimeState(anyRuntime.id, candidate.id, {
      status: "ready",
      observedDigest: candidate.artifactDigest,
    });
    const activated = store.activateAgentPluginVersion(plugin.id, candidate.id);
    expect(activated.activeVersionId).toBe(candidate.id);
    expect(activated.candidateVersionId).toBeNull();

    const rolledBack = store.rollbackAgentPluginVersion(plugin.id, plugin.activeVersionId);
    expect(rolledBack.activeVersionId).toBe(plugin.activeVersionId);
    expect(rolledBack.candidateVersionId).toBe(candidate.id);
  });

  it("blocks workspace moves while bindings exist and fails closed on legacy cross-workspace bindings", () => {
    const store = createStore();
    const target = store.createWorkspace({ id: "ws_plugin_target", name: "Target", slug: "plugin-target" });
    const agent = store.createAgent({ name: "Claude", provider: "claude", workspaceId: "local" });
    const plugin = store.importAgentPlugin(claudePluginInput());
    const binding = store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });

    expect(() => store.updateAgent(agent.id, { workspaceId: target.id })).toThrow(
      "remove all plugin bindings before moving this agent to another workspace",
    );
    expect(store.getAgent(agent.id)?.workspaceId).toBe("local");

    db!.run("UPDATE multiremi_agents SET workspace_id = ? WHERE id = ?", [target.id, agent.id]);
    const targetRuntime = store.registerRuntime({
      id: "rt_plugin_target",
      name: "Target Runtime",
      provider: "claude",
      workspaceId: target.id,
    });
    store.reconcileAgentPluginDesiredState("local");
    store.reconcileAgentPluginDesiredState(target.id);

    expect(() => store.listAgentPluginBindings(agent.id)).toThrow("same workspace");
    expect(() => store.resolveAgentPluginSnapshot(agent.id)).toThrow("same workspace");
    expect(store.getRuntimeAgentPluginDesiredSnapshot(targetRuntime.id).plugins).toEqual([]);

    expect(store.deleteAgentPluginBinding(agent.id, binding.id)).toBe(true);
    expect(store.listAgentPluginBindings(agent.id)).toEqual([]);
    expect(store.resolveAgentPluginSnapshot(agent.id)).toEqual([]);
    expect(store.updateAgent(agent.id, { workspaceId: "local" }).workspaceId).toBe("local");
  });

  it("removes archived Agent bindings from desired state and does not gate candidate activation", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const runtime = store.registerRuntime({
      id: "rt_plugin_archived_agent",
      name: "Runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const plugin = store.importAgentPlugin(claudePluginInput());
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins).toHaveLength(1);

    store.archiveAgent(agent.id);
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins).toEqual([]);

    const candidate = store.createAgentPluginVersion(plugin.id, {
      manifest: claudePluginInput("3.0.0").manifest,
      files: claudePluginInput("3.0.0").files,
      sourceRevision: "commit-3.0.0",
    });
    expect(store.activateAgentPluginVersion(plugin.id, candidate.id).activeVersionId).toBe(candidate.id);
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins).toEqual([]);

    store.restoreAgent(agent.id);
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins.map((entry) => entry.versionId)).toEqual([
      candidate.id,
    ]);
  });

  it("removes observed Plugin state when a Runtime is deleted", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const plugin = store.importAgentPlugin(claudePluginInput());
    const runtime = store.registerRuntime({
      id: "rt_plugin_delete",
      name: "Deleted Runtime",
      provider: "claude",
      workspaceId: "local",
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    expect(store.listAgentPluginRuntimeStates({ pluginId: plugin.id, includeHistorical: true })).toHaveLength(1);

    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(store.listAgentPluginRuntimeStates({ pluginId: plugin.id, includeHistorical: true })).toEqual([]);
  });
});
