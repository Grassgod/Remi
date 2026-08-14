import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { createStore, mockFetch, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — agent plugins", () => {
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
    const runtime = store.registerRuntime({
      id: "rt_api_plugin",
      name: "Plugin runtime",
      provider: "claude",
      daemonId: "daemon-local",
      workspaceId: "local",
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
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const daemonHeaders = { Authorization: `Bearer ${daemonToken.token}` };

    const desiredPath = `/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`;
    const statePath = `/api/daemon/runtimes/${runtime.id}/agent-plugins/${plugin.activeVersionId}/state`;
    const rejectedCredentials = [
      ["same-workspace PAT", localPat.token],
      ["cross-workspace PAT", remotePat.token],
      ["JWT", signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 })],
      ["master token", "root-secret"],
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
    expect(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).plugins[0]?.status).toBe("pending");

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
    expect(sameWorkspaceUser.status).toBe(200);
    const crossWorkspaceUser = await app.request(`/api/daemon/agent-plugin-artifacts/${digest}`, {
      headers: { Authorization: `Bearer ${remotePat.token}` },
    });
    expect(crossWorkspaceUser.status).toBe(404);
  });

  it("binds legacy daemon tokens on first registration and rejects identity changes", async () => {
    const store = createStore();
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
