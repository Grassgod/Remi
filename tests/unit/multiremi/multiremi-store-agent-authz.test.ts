// Agent creation/mutation/env/mcp_config gating and the redacted agent events,
// matched against the Go server's contracts.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, metricValue, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — Go-compatible agent authorization", () => {
  it("gates agent creation and runtime moves like the Go server", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ id: "bob", name: "Bob", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const alicePrivate = store.registerRuntime({
      id: "rt_gate_alice_private",
      name: "Alice private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
      models: [{
        id: "gpt-authz",
        label: "GPT Authz",
        provider: "openai",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "minimal", label: "Minimal" },
            { value: "high", label: "High" },
          ],
        },
      }],
    });
    const bobPublic = store.registerRuntime({
      id: "rt_gate_bob_public",
      name: "Bob public",
      provider: "claude",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
      models: [{
        id: "claude-authz",
        label: "Claude Authz",
        provider: "anthropic",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "max", label: "Max" },
          ],
        },
      }],
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_gate_remote",
      name: "Remote",
      provider: "codex",
      workspaceId: "remote",
      ownerId: "alice",
      visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    const invalidNativeCreate = await app.request("/api/multiremi/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: "{",
    });
    expect(invalidNativeCreate.status).toBe(400);
    expect(await invalidNativeCreate.json()).toEqual({ error: "invalid request body" });

    const invalidCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: "{",
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "invalid request body" });

    const unknownProvider = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Bad provider", provider: "gemini" }),
    });
    expect(unknownProvider.status).toBe(400);
    expect(await unknownProvider.json()).toEqual({ error: 'unknown provider "gemini"' });

    const crossWorkspaceRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Remote runtime", runtime_id: remoteRuntime.id }),
    });
    expect(crossWorkspaceRuntime.status).toBe(400);
    expect(await crossWorkspaceRuntime.json()).toEqual({ error: "invalid runtime_id" });

    const tooLongDescription = "x".repeat(256);
    const invalidDescriptionCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Long description", runtime_id: alicePrivate.id, description: tooLongDescription }),
    });
    expect(invalidDescriptionCreate.status).toBe(400);
    expect(await invalidDescriptionCreate.json()).toEqual({ error: "description must be 255 characters or fewer" });

    const invalidThinkingCreate = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ name: "Bad thinking", runtime_id: alicePrivate.id, thinking_level: "max" }),
    });
    expect(invalidThinkingCreate.status).toBe(400);
    expect(await invalidThinkingCreate.json()).toEqual({
      error: 'thinking_level "max" is not supported by model "gpt-authz" for provider "codex"',
    });

    const bobPrivateRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ name: "Bob blocked", runtime_id: alicePrivate.id }),
    });
    expect(bobPrivateRuntime.status).toBe(403);
    expect(await bobPrivateRuntime.json()).toEqual({
      error: "this runtime is private; only its owner or a workspace admin can create agents on it",
    });

    const bobPublicRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({
        name: "Bob public agent",
        runtime_id: bobPublic.id,
        provider: "codex",
        description: "Bob public description",
        avatar_url: "https://example.com/bob-agent.png",
      }),
    });
    expect(bobPublicRuntime.status).toBe(201);
    const bobAgent = await bobPublicRuntime.json();
    // Legacy runtime_id still forces the provider but no longer binds.
    expect(bobAgent.provider).toBe("claude");
    expect(store.getAgent(bobAgent.id)?.provider).toBe("claude");
    expect(store.getAgent(bobAgent.id)?.runtimeId).toBeNull();
    expect(store.getAgent(bobAgent.id)?.description).toBe("Bob public description");
    expect(store.getAgent(bobAgent.id)?.avatarUrl).toBe("https://example.com/bob-agent.png");
    expect(bobAgent.description).toBe("Bob public description");
    expect(bobAgent.avatar_url).toBe("https://example.com/bob-agent.png");
    expect(bobAgent.runtime_id).toBe("");
    expect(bobAgent.owner_id).toBe("bob");
    expect(bobAgent.max_concurrent_tasks).toBe(6);
    const bobAgentCreated = store.listAnalyticsEvents({ name: "agent_created" })[0]!;
    expect(bobAgentCreated.distinctId).toBe("bob");
    expect(bobAgentCreated.workspaceId).toBe("local");
    expect(bobAgentCreated.metricsOnly).toBe(false);
    expect(bobAgentCreated.properties).toMatchObject({
      agent_id: bobAgent.id,
      provider: "claude",
      runtime_mode: "local",
      template: "",
      is_first_agent_in_workspace: true,
      user_id: "bob",
      source: "manual",
      is_demo: false,
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(1);

    const invalidDefaultJson = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidDefaultJson.status).toBe(400);
    expect(await invalidDefaultJson.json()).toEqual({ error: "invalid request body" });

    // Pool model: the default agent seeds without a runtime and stays unbound.
    const defaultSeed = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: bobPublic.id, provider: "codex" }),
    });
    expect(defaultSeed.status).toBe(201);
    const defaultSeedBody = await defaultSeed.json();
    expect(defaultSeedBody.agent).toMatchObject({
      id: "agt_default_local_claude_bob",
      name: "Claude",
      provider: "claude",
      runtimeId: null,
      workspaceId: "local",
      ownerId: "bob",
      visibility: "private",
      description: "Default Claude agent",
    });
    const agentCreatedEventsAfterDefault = store.listAnalyticsEvents({ name: "agent_created" });
    expect(agentCreatedEventsAfterDefault).toHaveLength(2);
    expect(agentCreatedEventsAfterDefault[1]!.properties).toMatchObject({
      agent_id: "agt_default_local_claude_bob",
      provider: "claude",
      runtime_mode: "local",
      template: "default",
      is_first_agent_in_workspace: false,
      user_id: "bob",
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(2);

    // Provider-only seeding works and reuses the same default agent.
    const providerOnlyDefault = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(providerOnlyDefault.status).toBe(200);
    expect((await providerOnlyDefault.json()).agent.id).toBe("agt_default_local_claude_bob");

    const defaultSeedAgain = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: bobPublic.id }),
    });
    expect(defaultSeedAgain.status).toBe(200);
    expect((await defaultSeedAgain.json()).agent.id).toBe("agt_default_local_claude_bob");
    expect(store.listAnalyticsEvents({ name: "agent_created" })).toHaveLength(2);

    const invalidNativeUpdate = await app.request(`/api/multiremi/agents/${bobAgent.id}`, {
      method: "PATCH",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidNativeUpdate.status).toBe(400);
    expect(await invalidNativeUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: "{",
    });
    expect(invalidUpdate.status).toBe(400);
    expect(await invalidUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidDescriptionUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ description: tooLongDescription }),
    });
    expect(invalidDescriptionUpdate.status).toBe(400);
    expect(await invalidDescriptionUpdate.json()).toEqual({ error: "description must be 255 characters or fewer" });

    const invalidThinkingUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ thinking_level: "minimal" }),
    });
    expect(invalidThinkingUpdate.status).toBe(400);
    expect(await invalidThinkingUpdate.json()).toEqual({
      error: 'thinking_level "minimal" is not supported by model "claude-authz" for provider "claude"',
    });

    const duplicateName = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ name: "Bob public agent", runtime_id: bobPublic.id }),
    });
    expect(duplicateName.status).toBe(409);
    expect(await duplicateName.json()).toEqual({ error: "an agent named \"Bob public agent\" already exists in this workspace" });

    // Machine binding is gone, but a legacy "move" keeps its engine-switch
    // effect and the private-runtime gate: bob still can't reference alice's
    // private runtime.
    const forbiddenMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: alicePrivate.id }),
    });
    expect(forbiddenMove.status).toBe(403);

    // A legal legacy move switches the engine (and resets the model) without
    // binding the agent to the machine.
    store.updateAgent(bobAgent.id, { model: "claude-opus-4-8" });
    const codexPublic = store.registerRuntime({
      id: "rt_gate_codex_public",
      name: "Codex public",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "public",
    });
    const legacyMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: codexPublic.id }),
    });
    expect(legacyMove.status).toBe(200);
    expect((await legacyMove.json()).runtime_id).toBe("");
    expect(store.getAgent(bobAgent.id)?.runtimeId).toBeNull();
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");
    expect(store.getAgent(bobAgent.id)?.model).toBe("");

    // Provider is editable on unbound agents (and round-trips cleanly).
    const providerOnlyUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "codex" }),
    });
    expect(providerOnlyUpdate.status).toBe(200);
    const providerOnlyUpdateBody = await providerOnlyUpdate.json();
    expect(providerOnlyUpdateBody.provider).toBe("codex");
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");

    const unknownProviderUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "gemini" }),
    });
    expect(unknownProviderUpdate.status).toBe(400);
    expect(await unknownProviderUpdate.json()).toEqual({ error: 'unknown provider "gemini"' });

    const providerRestore = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(providerRestore.status).toBe(200);
    expect(store.getAgent(bobAgent.id)?.provider).toBe("claude");

    // A legacy move to an any-provider runtime must keep the agent's current
    // provider (not silently default to claude).
    store.updateAgent(bobAgent.id, { provider: "codex", model: "gpt-5.2" });
    const anyRuntime = store.registerRuntime({
      id: "rt_gate_any",
      name: "any gate",
      provider: "any",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const anyMove = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ runtime_id: anyRuntime.id }),
    });
    expect(anyMove.status).toBe(200);
    expect(store.getAgent(bobAgent.id)?.provider).toBe("codex");
    // Provider unchanged → model is preserved (no engine switch reset).
    expect(store.getAgent(bobAgent.id)?.model).toBe("gpt-5.2");
    store.updateAgent(bobAgent.id, { provider: "claude", model: "" });

    const descriptionUpdate = await app.request(`/api/agents/${bobAgent.id}`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({
        description: "Updated Bob description",
        avatar_url: "https://example.com/bob-agent-updated.png",
        thinking_level: "max",
      }),
    });
    expect(descriptionUpdate.status).toBe(200);
    const descriptionUpdateBody = await descriptionUpdate.json();
    expect(descriptionUpdateBody.description).toBe("Updated Bob description");
    expect(descriptionUpdateBody.avatar_url).toBe("https://example.com/bob-agent-updated.png");
    expect(descriptionUpdateBody.thinking_level).toBe("max");
    expect(store.getAgent(bobAgent.id)?.description).toBe("Updated Bob description");
    expect(store.getAgent(bobAgent.id)?.avatarUrl).toBe("https://example.com/bob-agent-updated.png");

    const adminPrivateRuntime = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ name: "Admin private agent", runtime_id: alicePrivate.id }),
    });
    expect(adminPrivateRuntime.status).toBe(201);
    const adminAgent = await adminPrivateRuntime.json();
    expect(adminAgent.runtime_id).toBe("");
    expect(adminAgent.provider).toBe("codex");
  });

  it("redacts agent mcp_config like the Go server", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
    const secretConfig = { mcpServers: { local: { command: "secret-command", env: { API_KEY: "secret" } } } };
    const agent = store.createAgent({
      id: "agt_mcp_redact",
      name: "MCP Redact",
      provider: "codex",
      ownerId: "owner",
      visibility: "workspace",
      mcpConfig: secretConfig,
    });

    const ownerRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(ownerToken.token) });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toMatchObject({
      id: agent.id,
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });

    const adminRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(adminToken.token) });
    expect(await adminRead.json()).toMatchObject({
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });

    const memberRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(memberToken.token) });
    expect(memberRead.status).toBe(200);
    expect(await memberRead.json()).toMatchObject({
      id: agent.id,
      mcp_config: null,
      mcp_config_redacted: true,
    });

    const memberList = await app.request("/api/agents", { headers: authHeaders(memberToken.token) });
    const listedAgent = (await memberList.json()).find((item: any) => item.id === agent.id);
    expect(listedAgent).toMatchObject({
      mcp_config: null,
      mcp_config_redacted: true,
    });

    const task = store.createTask({ agentId: agent.id, prompt: "read agent list" });
    const taskToken = await store.createTaskAccessToken(task, "owner");
    const taskRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(taskToken.token) });
    expect(taskRead.status).toBe(200);
    const taskDirectoryAgent = await taskRead.json();
    expect(taskDirectoryAgent).toMatchObject({
      id: agent.id,
      name: "MCP Redact",
      workspace_id: "local",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(JSON.stringify(taskDirectoryAgent)).toContain("secret-command");

    store.updateWorkspace("local", { settings: { always_redact_env: true } });
    const alwaysRedactedAdminRead = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(adminToken.token) });
    expect(await alwaysRedactedAdminRead.json()).toMatchObject({
      mcp_config: null,
      mcp_config_redacted: true,
    });
  });

  it("gates agent mutations and emits Go-style redacted agent events", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const runtime = store.registerRuntime({
      id: "rt_agent_event_public",
      name: "Agent Event Runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "owner",
      visibility: "public",
    });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const secretConfig = { mcpServers: { local: { command: "secret-command", env: { API_KEY: "secret" } } } };

    const created = await app.request("/api/agents", {
      method: "POST",
      headers: jsonHeaders(ownerToken.token),
      body: JSON.stringify({
        name: "Event Agent",
        runtime_id: runtime.id,
        visibility: "workspace",
        mcp_config: secretConfig,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      name: "Event Agent",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:created")).toMatchObject({
      workspaceId: "local",
      actorType: "member",
      actorId: "owner",
      payload: {
        agent: {
          id: createdBody.id,
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const memberUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ name: "Member Should Not Update" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const task = store.createTask({ agentId: createdBody.id, prompt: "try to mutate agent" });
    const taskToken = await store.createTaskAccessToken(task, "owner");
    const taskUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(taskToken.token),
      body: JSON.stringify({ name: "Task Owner Update" }),
    });
    expect(taskUpdate.status).toBe(200);
    expect(await taskUpdate.json()).toMatchObject({ name: "Task Owner Update" });

    const ownerUpdate = await app.request(`/api/agents/${createdBody.id}`, {
      method: "PUT",
      headers: jsonHeaders(ownerToken.token),
      body: JSON.stringify({ name: "Event Agent Updated" }),
    });
    expect(ownerUpdate.status).toBe(200);
    expect(await ownerUpdate.json()).toMatchObject({
      name: "Event Agent Updated",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) =>
      event.type === "agent:status" &&
      (event.payload.agent as any)?.id === createdBody.id &&
      (event.payload.agent as any)?.name === "Event Agent Updated"
    )).toMatchObject({
      actorId: "owner",
      payload: {
        agent: {
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const adminArchive = await app.request(`/api/agents/${createdBody.id}/archive`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
    });
    expect(adminArchive.status).toBe(200);
    expect(await adminArchive.json()).toMatchObject({
      id: createdBody.id,
      status: "archived",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:archived")).toMatchObject({
      actorId: "admin",
      payload: {
        agent: {
          id: createdBody.id,
          status: "archived",
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });

    const memberRestore = await app.request(`/api/agents/${createdBody.id}/restore`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
    });
    expect(memberRestore.status).toBe(403);
    expect(await memberRestore.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const ownerRestore = await app.request(`/api/agents/${createdBody.id}/restore`, {
      method: "POST",
      headers: jsonHeaders(ownerToken.token),
    });
    expect(ownerRestore.status).toBe(200);
    expect(await ownerRestore.json()).toMatchObject({
      id: createdBody.id,
      status: "active",
      mcp_config: secretConfig,
      mcp_config_redacted: false,
    });
    expect(events.find((event) => event.type === "agent:restored")).toMatchObject({
      actorId: "owner",
      payload: {
        agent: {
          id: createdBody.id,
          status: "active",
          mcp_config: null,
          mcp_config_redacted: true,
        },
      },
    });
  });

  it("gates agent env management like the Go server", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "owner", name: "Owner", role: "owner" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "owner" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const agent = store.createAgent({
      id: "agt_env_gate",
      name: "Env Gate",
      provider: "codex",
      ownerId: "member",
      customEnv: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });

    const memberRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(memberToken.token) });
    expect(memberRead.status).toBe(403);
    expect(await memberRead.json()).toEqual({ error: "insufficient permissions" });

    const memberWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(memberToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "changed" } }),
    });
    expect(memberWrite.status).toBe(403);
    expect(await memberWrite.json()).toEqual({ error: "insufficient permissions" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "real-value", KEEP_ME: "yes" });

    const ownerRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(ownerToken.token) });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });

    const envTask = store.createTask({ agentId: agent.id, prompt: "env access" });
    const envTaskToken = await store.createTaskAccessToken(envTask, "owner");
    const taskTokenRead = await app.request(`/api/agents/${agent.id}/env`, { headers: headers(envTaskToken.token) });
    expect(taskTokenRead.status).toBe(200);
    expect(await taskTokenRead.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });

    const taskTokenWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(envTaskToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "changed" } }),
    });
    expect(taskTokenWrite.status).toBe(200);
    expect(await taskTokenWrite.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "changed" },
    });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "changed" });

    const invalidWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(ownerToken.token),
      body: "{",
    });
    expect(invalidWrite.status).toBe(400);
    expect(await invalidWrite.json()).toEqual({ error: "invalid request body" });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "changed" });

    const ownerWrite = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(ownerToken.token),
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ADDED: "new" } }),
    });
    expect(ownerWrite.status).toBe(200);
    expect(await ownerWrite.json()).toEqual({
      agent_id: agent.id,
      custom_env: { SECRET_TOKEN: "changed", ADDED: "new" },
    });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({ SECRET_TOKEN: "changed", ADDED: "new" });

    const adminClear = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: headers(adminToken.token),
      body: JSON.stringify({ custom_env: {} }),
    });
    expect(adminClear.status).toBe(200);
    expect(await adminClear.json()).toEqual({ agent_id: agent.id, custom_env: {} });
    expect(store.getAgent(agent.id)?.customEnv).toEqual({});
  });
});
