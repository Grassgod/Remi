import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import type { ResolveAgentPluginGitSourceInput } from "@multiremi/agent-plugins/git-import.js";
import { createStore, mockFetch, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — agent plugins", () => {
  it("inspects and imports a Git Plugin source as an immutable artifact", async () => {
    const store = createStore();
    const resolverCalls: ResolveAgentPluginGitSourceInput[] = [];
    const resolveAgentPluginGitSource = async (input: ResolveAgentPluginGitSourceInput) => {
      resolverCalls.push(input);
      return {
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: "main",
        defaultBranch: "main",
        branches: ["develop", "main"],
        sourceRevision: "1234567890abcdef1234567890abcdef12345678",
        candidates: [{
          provider: "claude" as const,
          name: "review-tools",
          description: "Review code",
          version: "1.2.0",
          pluginSubdir: "plugins/review",
          manifestPath: ".claude-plugin/plugin.json",
          manifest: { name: "review-tools", version: "1.2.0" },
          fileCount: 2,
          artifactSize: 48,
          artifactSizeKnown: input.includeFiles === true,
          ...(input.includeFiles === true
            ? {
                files: [{
                  path: "skills/review/SKILL.md",
                  content: Buffer.from("# Review\n").toString("base64"),
                  encoding: "base64" as const,
                }],
              }
            : {}),
        }],
      };
    };
    const app = createMultiremiApp({
      store,
      resolveAgentPluginGitSource,
    });

    const inspected = await app.request("/api/multiremi/agent-plugins/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        source_url: "https://example.com/plugins.git",
      }),
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      inspection: {
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: "main",
        defaultBranch: "main",
        sourceRevision: "1234567890abcdef1234567890abcdef12345678",
        candidates: [{
          provider: "claude",
          name: "review-tools",
          sourceSubdir: "plugins/review",
          version: "1.2.0",
          artifactSizeKnown: false,
        }],
      },
    });

    const imported = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "git",
        workspace_id: "local",
        source_url: "https://example.com/plugins.git",
        source_ref: "main",
        source_subdir: "plugins/review",
        provider: "claude",
        manifest_path: ".claude-plugin/plugin.json",
        expected_revision: "1234567890abcdef1234567890abcdef12345678",
      }),
    });
    expect(imported.status).toBe(201);
    const plugin = (await imported.json()).plugin;
    expect(plugin).toMatchObject({
      provider: "claude",
      sourceType: "git",
      sourceUrl: "https://example.com/plugins.git",
      sourceRef: "main",
      sourceSubdir: "plugins/review",
      activeVersion: {
        version: "1.2.0",
        sourceRevision: "1234567890abcdef1234567890abcdef12345678",
        metadata: {
          source_url: "https://example.com/plugins.git",
          source_ref: "main",
          source_subdir: "plugins/review",
          source_manifest_path: ".claude-plugin/plugin.json",
          source_provider: "claude",
        },
      },
    });
    expect(store.getAgentPluginArtifactByDigest(plugin.activeVersion.artifactDigest)?.artifact)
      .toMatchObject({
        files: expect.arrayContaining([
          expect.objectContaining({ path: "skills/review/SKILL.md" }),
        ]),
      });
    expect(resolverCalls).toEqual([
      {
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: undefined,
        sourceSubdir: undefined,
      },
      {
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: "main",
        sourceSubdir: "plugins/review",
        provider: "claude",
        manifestPath: ".claude-plugin/plugin.json",
        includeFiles: true,
        exactSourceSubdir: true,
      },
    ]);
  });

  it("selects provider manifests precisely when they share a repository directory", async () => {
    const store = createStore();
    const app = createMultiremiApp({
      store,
      resolveAgentPluginGitSource: async () => ({
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: "main",
        defaultBranch: "main",
        branches: ["main"],
        sourceRevision: "1234567890abcdef1234567890abcdef12345678",
        candidates: [
          {
            provider: "claude" as const,
            name: "shared-claude",
            description: "",
            version: "1.0.0",
            pluginSubdir: "",
            manifestPath: ".claude-plugin/plugin.json",
            manifest: { name: "shared-claude", version: "1.0.0" },
            fileCount: 1,
            artifactSize: 48,
            artifactSizeKnown: true,
            files: [],
          },
          {
            provider: "codex" as const,
            name: "shared-codex",
            description: "",
            version: "2.0.0",
            pluginSubdir: "",
            manifestPath: ".codex-plugin/plugin.json",
            manifest: { name: "shared-codex", version: "2.0.0" },
            fileCount: 1,
            artifactSize: 48,
            artifactSizeKnown: true,
            files: [],
          },
        ],
      }),
    });

    const ambiguous = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "git",
        source_url: "https://example.com/plugins.git",
        source_subdir: "",
      }),
    });
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ code: "plugin_selection_required" });

    const imported = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "git",
        source_url: "https://example.com/plugins.git",
        source_subdir: "",
        provider: "codex",
        manifest_path: ".codex-plugin/plugin.json",
      }),
    });
    expect(imported.status).toBe(201);
    expect((await imported.json()).plugin).toMatchObject({
      provider: "codex",
      name: "shared-codex",
      sourceSubdir: null,
    });
  });

  it("inherits the stored Git source identity when importing a new version", async () => {
    const store = createStore();
    const plugin = store.importAgentPlugin({
      workspaceId: "local",
      provider: "claude",
      manifest: { name: "review-tools", version: "1.0.0" },
      sourceType: "git",
      sourceUrl: "https://example.com/plugins.git",
      sourceRef: "release",
      sourceSubdir: "plugins/review",
    });
    const resolverCalls: ResolveAgentPluginGitSourceInput[] = [];
    const app = createMultiremiApp({
      store,
      resolveAgentPluginGitSource: async (input) => {
        resolverCalls.push(input);
        return {
          sourceUrl: "https://example.com/plugins.git",
          sourceRef: "release",
          defaultBranch: "main",
          branches: ["main", "release"],
          sourceRevision: "1234567890abcdef1234567890abcdef12345678",
          candidates: [{
            provider: "claude" as const,
            name: "review-tools",
            description: "",
            version: "2.0.0",
            pluginSubdir: "plugins/review",
            manifestPath: ".claude-plugin/plugin.json",
            manifest: { name: "review-tools", version: "2.0.0" },
            fileCount: 1,
            artifactSize: 48,
            artifactSizeKnown: true,
            files: [],
          }],
        };
      },
    });

    const response = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "git", id: plugin.id }),
    });
    expect(response.status).toBe(201);
    expect(resolverCalls).toEqual([{
      sourceUrl: "https://example.com/plugins.git",
      sourceRef: "release",
      sourceSubdir: "plugins/review",
      provider: "claude",
      manifestPath: null,
      includeFiles: true,
      exactSourceSubdir: true,
    }]);
  });

  it("does not reveal cross-workspace Plugin ids through Git version imports", async () => {
    const store = createStore();
    const owner = store.getOrCreateUser({
      externalId: "plugin-owner",
      email: "plugin-owner@example.com",
      name: "Plugin Owner",
    });
    const caller = store.getOrCreateUser({
      externalId: "plugin-caller",
      email: "plugin-caller@example.com",
      name: "Plugin Caller",
    });
    const privateWorkspace = store.createWorkspace({
      id: "ws_plugin_private",
      name: "Plugin Private",
      slug: "plugin-private",
    }, owner.id);
    const callerWorkspace = store.createWorkspace({
      id: "ws_plugin_caller",
      name: "Plugin Caller",
      slug: "plugin-caller",
    }, caller.id);
    const plugin = store.importAgentPlugin({
      workspaceId: privateWorkspace.id,
      provider: "claude",
      manifest: { name: "private-tools", version: "1.0.0" },
    });
    const token = await store.createAccessToken({
      name: "Plugin caller",
      type: "pat",
      workspaceId: callerWorkspace.id,
      userId: caller.id,
    });
    let resolverCalls = 0;
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      resolveAgentPluginGitSource: async () => {
        resolverCalls += 1;
        throw new Error("resolver must not run");
      },
    });
    const request = (id: string) => app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "git",
        id,
        workspace_id: callerWorkspace.id,
        source_url: "https://example.com/plugins.git",
      }),
    });

    const known = await request(plugin.id);
    const unknown = await request("apl_does_not_exist");
    expect(known.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await known.json()).toEqual({
      error: "plugin not found",
      code: "plugin_not_found",
    });
    expect(await unknown.json()).toEqual({
      error: "plugin not found",
      code: "plugin_not_found",
    });
    expect(resolverCalls).toBe(0);
  });

  it("rejects a Git import when the branch changes after inspection", async () => {
    const store = createStore();
    const app = createMultiremiApp({
      store,
      resolveAgentPluginGitSource: async () => ({
        sourceUrl: "https://example.com/plugins.git",
        sourceRef: "main",
        defaultBranch: "main",
        branches: ["main"],
        sourceRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        candidates: [{
          provider: "claude",
          name: "review-tools",
          description: "",
          version: "1.0.0",
          pluginSubdir: "",
          manifestPath: ".claude-plugin/plugin.json",
          manifest: { name: "review-tools", version: "1.0.0" },
          fileCount: 1,
          artifactSize: 48,
          artifactSizeKnown: true,
          files: [],
        }],
      }),
    });

    const response = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "git",
        source_url: "https://example.com/plugins.git",
        source_subdir: "",
        expected_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Plugin repository changed after inspection; read it again before importing",
      code: "plugin_git_revision_changed",
    });
    expect(store.listAgentPlugins()).toEqual([]);
  });

  it("keeps duplicate Runtime state reports idempotent", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_plugin_idempotent",
      name: "Idempotent runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "idempotent", version: "1.0.0" },
      files: [{ path: "skills/idempotent/SKILL.md", content: "# Idempotent\n" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });

    const failureInput = {
      status: "setup_required",
      attempts: 1,
      retryGeneration: 0,
      nextRetryAt: "2026-08-14T08:00:00.000Z",
      lastErrorCode: "plugin_binary_missing",
      lastError: "lark-cli is missing",
    };
    const firstFailure = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, failureInput);
    await Bun.sleep(5);
    const repeatedFailure = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, failureInput);
    expect(repeatedFailure).toMatchObject({
      retryCount: 1,
      lastAttemptAt: firstFailure.lastAttemptAt,
      updatedAt: firstFailure.updatedAt,
    });

    const readyInput = {
      status: "ready",
      attempts: 0,
      retryGeneration: 0,
      observedDigest: plugin.activeVersion!.artifactDigest,
    };
    const firstReady = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, readyInput);
    await Bun.sleep(5);
    const repeatedReady = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, readyInput);
    expect(repeatedReady).toMatchObject({
      retryCount: 1,
      lastAttemptAt: firstReady.lastAttemptAt,
      lastReadyAt: firstReady.lastReadyAt,
      updatedAt: firstReady.updatedAt,
    });

    const retried = store.retryAgentPluginRuntime(plugin.id, runtime.id, plugin.activeVersionId!)[0]!;
    expect(retried).toMatchObject({ status: "pending", retryGeneration: 1, retryCount: 0 });
    const staleReady = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, readyInput);
    expect(staleReady).toMatchObject({
      status: "pending",
      retryGeneration: 1,
      observedDigest: null,
      updatedAt: retried.updatedAt,
    });
  });

  it("imports, binds and exposes provider-specific plugins", async () => {
    const store = createStore();
    const claude = store.createAgent({ name: "Claude", provider: "claude" });
    const codex = store.createAgent({ name: "Codex", provider: "codex" });
    const app = createMultiremiApp({ store });

    const imported = await app.request("/api/multiremi/agent-plugins/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        provider: "claude",
        manifest: { name: "lark", version: "1.0.0", description: "Lark" },
        files: [{ path: "skills/lark-doc/SKILL.md", content: "# Lark" }],
        source_type: "git",
        source_url: "https://example.com/lark.git",
        source_revision: "abc123",
      }),
    });
    expect(imported.status).toBe(201);
    const plugin = (await imported.json()).plugin;
    expect(plugin).toMatchObject({ provider: "claude", sourceType: "git", bindingCount: 0 });
    expect(plugin.activeVersion.files[0].content).toBeUndefined();

    const mismatch = await app.request(`/api/multiremi/agents/${codex.id}/plugins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_id: plugin.id }),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "provider_mismatch" });

    const bound = await app.request(`/api/multiremi/agents/${claude.id}/plugins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_id: plugin.id }),
    });
    expect(bound.status).toBe(201);
    const boundBody = await bound.json();
    expect(boundBody.binding).toMatchObject({
      pluginId: plugin.id,
      connectionId: null,
      resolvedVersionId: plugin.activeVersionId,
    });
    expect(boundBody.capabilityRevision).toMatch(/^[0-9a-f]{64}$/);

    const switchProvider = await app.request(`/api/multiremi/agents/${claude.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex" }),
    });
    expect(switchProvider.status).toBe(409);
    expect(await switchProvider.json()).toEqual({
      error: 'unbind claude plugin "lark" before switching agent provider to codex',
      code: "provider_mismatch",
    });
    expect(store.getAgent(claude.id)?.provider).toBe("claude");

    const targetWorkspace = store.createWorkspace({
      id: "ws_plugin_move_target",
      name: "Plugin Move Target",
      slug: "plugin-move-target",
    });
    const moveBoundAgent = await app.request(`/api/multiremi/agents/${claude.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: targetWorkspace.id }),
    });
    expect(moveBoundAgent.status).toBe(409);
    expect(await moveBoundAgent.json()).toEqual({
      error: "remove all plugin bindings before moving this agent to another workspace",
      code: "agent_plugin_workspace_move_blocked",
    });
    expect(store.getAgent(claude.id)?.workspaceId).toBe("local");

    const list = await app.request("/api/multiremi/agent-plugins?workspace_id=local&provider=claude");
    expect(list.status).toBe(200);
    expect((await list.json()).plugins[0]).toMatchObject({ id: plugin.id, bindingCount: 1 });
  });

  it("requires access to an Agent move's target workspace", async () => {
    const store = createStore();
    const user = store.getOrCreateUser({
      externalId: "plugin-move-user",
      email: "plugin-move@example.com",
      name: "Plugin Move User",
    });
    const source = store.createWorkspace({
      id: "ws_plugin_move_source",
      name: "Plugin Move Source",
      slug: "plugin-move-source",
    }, user.id);
    const target = store.createWorkspace({
      id: "ws_plugin_move_private",
      name: "Plugin Move Private",
      slug: "plugin-move-private",
    }, "local");
    const agent = store.createAgent({
      name: "Claude",
      provider: "claude",
      workspaceId: source.id,
      ownerId: user.id,
    });
    const token = await store.createAccessToken({
      name: "Plugin move user",
      type: "pat",
      workspaceId: source.id,
      userId: user.id,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request(`/api/multiremi/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: target.id }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "workspace not found" });
    expect(store.getAgent(agent.id)?.workspaceId).toBe(source.id);
  });

  it("rejects Plugin connection and config values until Runtime injection exists", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "lark", version: "1.0.0" },
    });
    const app = createMultiremiApp({ store });

    const configured = await app.request(`/api/multiremi/agents/${agent.id}/plugins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plugin_id: plugin.id,
        connection_id: "lark-main",
        config: { scope: "docs" },
      }),
    });
    expect(configured.status).toBe(400);
    expect(await configured.json()).toEqual({
      error: "plugin connections and runtime configuration are not supported yet",
      code: "plugin_binding_configuration_unsupported",
    });

    const bound = store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    const updated = await app.request(`/api/multiremi/agents/${agent.id}/plugins/${bound.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { scope: "sheets" } }),
    });
    expect(updated.status).toBe(400);
    expect(await updated.json()).toMatchObject({
      code: "plugin_binding_configuration_unsupported",
    });
  });

  it("serves desired state, observed reports, retry generations and exact artifact bytes to daemons", async () => {
    const store = createStore();
    const runtimeStateEvents: any[] = [];
    store.onWorkspaceEvent((event) => {
      if (event.type === "agent_plugin:runtime_state") runtimeStateEvents.push(event);
    });
    const runtime = store.registerRuntime({
      id: "rt_api_plugin",
      name: "Plugin runtime",
      provider: "claude",
      daemonId: "daemon-local",
      workspaceId: "local",
      metadata: { agent_plugin_protocol: 1 },
    });
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "lark", version: "1.0.0" },
      files: [{ path: "skills/lark/SKILL.md", content: "# Lark" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    const daemonToken = await store.createAccessToken({
      name: "Local daemon",
      type: "daemon",
      daemonId: "daemon-local",
      workspaceId: "local",
    });
    const remoteToken = await store.createAccessToken({
      name: "Remote daemon",
      type: "daemon",
      daemonId: "daemon-remote",
      workspaceId: "remote",
    });
    const wrongDaemon = await store.createAccessToken({
      name: "Wrong local daemon",
      type: "daemon",
      daemonId: "daemon-other",
      workspaceId: "local",
    });
    const unboundDaemon = await store.createAccessToken({
      name: "Unbound local daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const localPat = await store.createAccessToken({
      name: "Local user",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const remotePat = await store.createAccessToken({
      name: "Remote user",
      type: "pat",
      workspaceId: "remote",
      userId: "remote-user",
    });
    const taskCredentialTask = store.createTask({ agentId: agent.id, prompt: "Task credential scope" });
    const taskCredential = await store.createTaskAccessToken(taskCredentialTask, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const daemonHeaders = { Authorization: `Bearer ${daemonToken.token}` };

    const desiredPath = `/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`;
    const statePath = `/api/daemon/runtimes/${runtime.id}/agent-plugins/${plugin.activeVersionId}/state`;
    const rejectedCredentials = [
      ["same-workspace PAT", localPat.token],
      ["cross-workspace PAT", remotePat.token],
      ["JWT", signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 })],
      ["task token", taskCredential.token],
      ["cross-workspace daemon", remoteToken.token],
      ["wrong daemon identity", wrongDaemon.token],
      ["unbound daemon identity", unboundDaemon.token],
    ] as const;
    for (const [label, token] of rejectedCredentials) {
      const deniedDesired = await app.request(desiredPath, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(deniedDesired.status, `${label} desired state`).toBe(403);
      const deniedReport = await app.request(statePath, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest }),
      });
      expect(deniedReport.status, `${label} state report`).toBe(403);
    }
    const masterDesired = await app.request(desiredPath, {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(masterDesired.status).toBe(200);
    const deniedHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wrongDaemon.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: runtime.id, agent_plugin_protocol: 0 }),
    });
    expect(deniedHeartbeat.status).toBe(403);
    expect(await deniedHeartbeat.json()).toMatchObject({ code: "daemon_identity_forbidden" });
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
    const deniedHumanCapability = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localPat.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: runtime.id, agent_plugin_protocol: 0 }),
    });
    expect(deniedHumanCapability.status).toBe(403);
    expect(await deniedHumanCapability.json()).toMatchObject({ code: "daemon_token_required" });
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
    const deniedHumanHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localPat.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(deniedHumanHeartbeat.status).toBe(403);
    expect(await deniedHumanHeartbeat.json()).toMatchObject({ code: "daemon_token_required" });
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins[0]?.status).toBe("pending");

    const masterHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer root-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: runtime.id, agent_plugin_protocol: 2 }),
    });
    expect(masterHeartbeat.status).toBe(200);
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(2);

    const desired = await app.request(desiredPath, {
      headers: daemonHeaders,
    });
    expect(desired.status).toBe(200);
    const desiredBody = await desired.json();
    expect(desiredBody.runtime_id).toBe(runtime.id);
    expect(desiredBody.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(desiredBody.plugins[0]).toMatchObject({
      plugin_id: plugin.id,
      version_id: plugin.activeVersionId,
      digest: plugin.activeVersion!.artifactDigest,
      retry_generation: 0,
      status: "pending",
    });

    const reported = await app.request(
      statePath,
      {
        method: "POST",
        headers: { ...daemonHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest }),
      },
    );
    expect(reported.status).toBe(200);
    expect((await reported.json()).state).toMatchObject({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest });
    const repeatedReport = await app.request(statePath, {
      method: "POST",
      headers: { ...daemonHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest }),
    });
    expect(repeatedReport.status).toBe(200);
    expect(runtimeStateEvents).toHaveLength(1);

    const masterReport = await app.request(statePath, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest }),
    });
    expect(masterReport.status).toBe(200);

    const openApp = createMultiremiApp({ store, authToken: "" });
    expect((await openApp.request(desiredPath)).status).toBe(200);
    expect((await openApp.request(statePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready", observed_digest: plugin.activeVersion!.artifactDigest }),
    })).status).toBe(200);
    expect((await openApp.request(desiredPath, {
      headers: { Authorization: `Bearer ${localPat.token}` },
    })).status).toBe(403);

    const retry = await app.request(`/api/multiremi/agent-plugins/${plugin.id}/runtimes/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).states[0]).toMatchObject({ status: "pending", retryGeneration: 1 });

    const digest = plugin.activeVersion!.artifactDigest;
    const artifact = await app.request(`/api/daemon/agent-plugin-artifacts/${digest}`, { headers: daemonHeaders });
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toBe("application/vnd.multiremi.agent-plugin+json");
    const artifactBytes = await artifact.text();
    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(digest);

    const crossWorkspace = await app.request(`/api/daemon/agent-plugin-artifacts/${digest}`, {
      headers: { Authorization: `Bearer ${remoteToken.token}` },
    });
    expect(crossWorkspace.status).toBe(404);

    const sameWorkspaceUser = await app.request(`/api/daemon/agent-plugin-artifacts/${digest}`, {
      headers: { Authorization: `Bearer ${localPat.token}` },
    });
    expect(sameWorkspaceUser.status).toBe(403);
    expect(await sameWorkspaceUser.json()).toMatchObject({ code: "daemon_token_required" });
    const crossWorkspaceUser = await app.request(`/api/daemon/agent-plugin-artifacts/${digest}`, {
      headers: { Authorization: `Bearer ${remotePat.token}` },
    });
    expect(crossWorkspaceUser.status).toBe(403);
    expect(await crossWorkspaceUser.json()).toMatchObject({ code: "daemon_token_required" });
  });

  it("binds legacy daemon tokens on first registration and rejects identity changes", async () => {
    const store = createStore();
    const capabilityEvents: any[] = [];
    store.onWorkspaceEvent((event) => {
      if (event.type === "agent_plugin:runtime_capability") capabilityEvents.push(event);
    });
    const daemonToken = await store.createAccessToken({
      name: "Legacy daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = {
      Authorization: `Bearer ${daemonToken.token}`,
      "Content-Type": "application/json",
    };

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-bound",
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(registered.status).toBe(200);
    const registeredBody = await registered.json();
    const runtimeId = registeredBody.runtimes[0].id;
    expect(store.getAccessToken(daemonToken.id)?.daemonId).toBe("daemon-bound");
    expect(store.getRuntime(runtimeId)?.daemonId).toBe("daemon-bound");
    expect(store.getRuntime(runtimeId)?.metadata.agent_plugin_protocol).toBe(0);
    expect(capabilityEvents[0]?.payload).toMatchObject({
      runtime_id: runtimeId,
      previous_agent_plugin_protocol: null,
      agent_plugin_protocol: 0,
      supported: false,
    });

    const upgraded = await app.request("/api/daemon/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-bound",
        capabilities: { agent_plugins: 1 },
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(upgraded.status).toBe(200);
    expect(store.getRuntime(runtimeId)?.metadata.agent_plugin_protocol).toBe(1);
    expect(capabilityEvents).toHaveLength(2);
    expect(capabilityEvents[1]?.payload).toMatchObject({
      runtime_id: runtimeId,
      previous_agent_plugin_protocol: 0,
      agent_plugin_protocol: 1,
      supported: true,
    });

    const repeatedUpgrade = await app.request("/api/daemon/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-bound",
        capabilities: { agent_plugins: 1 },
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(repeatedUpgrade.status).toBe(200);
    expect(capabilityEvents).toHaveLength(2);

    const missingRuntimeIdentity = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "rt_missing_daemon_identity",
        name: "Missing daemon identity",
        provider: "claude",
        workspaceId: "local",
      }),
    });
    expect(missingRuntimeIdentity.status).toBe(403);
    expect(store.getRuntime("rt_missing_daemon_identity")).toBeNull();

    const forgedRuntimeIdentity = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "rt_forged_daemon_identity",
        name: "Forged daemon identity",
        provider: "claude",
        workspaceId: "local",
        daemonId: "daemon-forged",
      }),
    });
    expect(forgedRuntimeIdentity.status).toBe(403);
    expect(store.getRuntime("rt_forged_daemon_identity")).toBeNull();

    const desired = await app.request(`/api/daemon/runtimes/${runtimeId}/agent-plugins/desired`, {
      headers: { Authorization: `Bearer ${daemonToken.token}` },
    });
    expect(desired.status).toBe(200);

    const identityChange = await app.request("/api/daemon/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-forged",
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(identityChange.status).toBe(403);
    expect(await identityChange.json()).toEqual({
      error: "forbidden for daemon identity",
      code: "daemon_identity_forbidden",
    });
    expect(store.getAccessToken(daemonToken.id)?.daemonId).toBe("daemon-bound");
  });

  it("ignores forged execution snapshots submitted through the public task API", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_api_plugin_forgery",
      name: "Plugin forgery runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Protected Plugin agent", provider: "claude" });
    const required = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "required-plugin", version: "1.0.0" },
    });
    store.createAgentPluginBinding(agent.id, { pluginId: required.id });
    const decoy = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "ready-decoy", version: "1.0.0" },
    });
    const decoyAgent = store.createAgent({ name: "Decoy Plugin agent", provider: "claude" });
    store.createAgentPluginBinding(decoyAgent.id, { pluginId: decoy.id });
    store.reportAgentPluginRuntimeState(runtime.id, decoy.activeVersionId!, {
      status: "ready",
      observedDigest: decoy.activeVersion!.artifactDigest,
    });
    const app = createMultiremiApp({ store });

    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: agent.id,
        prompt: "bypass the required Plugin",
        provider: "claude",
        execution_fingerprint: "f".repeat(64),
        assignmentSourceEventId: "sev_forged_camel",
        assignment_source_event_id: "sev_forged_snake",
        plugin_snapshot: [{
          bindingId: "forged-binding",
          pluginId: decoy.id,
          versionId: decoy.activeVersionId,
          name: "ready-decoy",
          provider: "claude",
          version: "1.0.0",
          digest: decoy.activeVersion!.artifactDigest,
          artifactUrl: decoy.activeVersion!.artifactUrl,
          config: {},
          connectionId: null,
        }],
      }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).task).toMatchObject({
      pluginSnapshot: [],
      executionFingerprint: null,
      assignmentSourceEventId: null,
    });
    expect(store.claimTask(runtime.id)).toBeNull();
  });

  it("includes the frozen Plugin snapshot in daemon claim wire and client models", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_api_plugin_claim",
      name: "Plugin claim runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Plugin claim agent", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "claim-proof", version: "1.0.0" },
      files: [{ path: "skills/claim-proof/SKILL.md", content: "# Claim proof\n" }],
    });
    const binding = store.createAgentPluginBinding(agent.id, {
      pluginId: plugin.id,
      config: { channel: "docs" },
      connectionId: "conn_docs",
    });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Use the Plugin" });
    const app = createMultiremiApp({ store });

    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const claimed = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);

    expect(claimed).toMatchObject({
      id: task.id,
      executionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      pluginSnapshot: [{
        bindingId: binding.id,
        pluginId: plugin.id,
        versionId: plugin.activeVersionId,
        provider: "claude",
        version: "1.0.0",
        digest: plugin.activeVersion!.artifactDigest,
        config: { channel: "docs" },
        connectionId: "conn_docs",
      }],
    });
  });

  it("blocks activation until online runtimes report the candidate digest ready", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_api_activate", name: "Runtime", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const plugin = store.importAgentPlugin({
      provider: "codex",
      manifest: { name: "wiki", version: "1.0.0" },
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    const app = createMultiremiApp({ store });

    const created = await app.request(`/api/multiremi/agent-plugins/${plugin.id}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: { name: "wiki", version: "1.1.0" } }),
    });
    expect(created.status).toBe(201);
    const version = (await created.json()).version;

    const blocked = await app.request(`/api/multiremi/agent-plugins/${plugin.id}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: version.id }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "plugin_version_not_ready" });

    store.reportAgentPluginRuntimeState(runtime.id, version.id, {
      status: "ready",
      observedDigest: version.artifactDigest,
    });
    const activated = await app.request(`/api/multiremi/agent-plugins/${plugin.id}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: version.id }),
    });
    expect(activated.status).toBe(200);
    expect((await activated.json()).plugin).toMatchObject({ activeVersionId: version.id, candidateVersionId: null });
  });
});
