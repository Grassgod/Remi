import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({
    id: "group-a", name: "Machine A", daemonId: "machine-a", provider: "codex", ownerId: "local",
    metadata: { codex_profiles: 1 },
    models: [{ id: "common", label: "Common", provider: "openai", default: true, thinking: { supportedLevels: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] } }],
  });
  const peer = store.registerRuntime({
    id: "group-b", name: "Machine B", daemonId: "machine-b", provider: "codex", ownerId: "local",
    metadata: { codex_profiles: 1 },
    models: [{ id: "common", label: "Common", provider: "openai", default: true, thinking: { supportedLevels: [{ value: "low", label: "Low" }] } }, { id: "peer-only", label: "Peer", provider: "openai", default: false }],
  });
  const app = createMultiremiApp({ store });
  const request = (path: string, body: unknown, method = "POST") => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const join = () => {
    store.updateRuntime(runtime.id, { executionGroupId: "shared" });
    store.updateRuntime(peer.id, { executionGroupId: "shared" });
  };
  return { store, runtime, peer, app, request, join };
}

describe("execution group API", () => {
  it("creates Antigravity groups and dispatches their agents", async () => {
    const { store, app, request } = setup();
    const registered = await request("/api/multiremi/runtimes", {
      name: "Antigravity", provider: "antigravity", execution_group_id: "agy-group",
    });
    expect(registered.status).toBe(201);
    const { runtime } = await registered.json();
    const response = await request("/api/agents", { name: "Antigravity worker", execution_group_id: "agy-group" });
    expect(response.status).toBe(201);
    const agent = await response.json();
    expect(agent.provider).toBe("antigravity");
    const task = store.createTask({ agentId: agent.id, prompt: "Run in the group" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const catalog = await (await app.request("/api/models?execution_group_id=agy-group")).json();
    expect(catalog.providers[0].provider).toBe("antigravity");
  });

  it("routes a native model across groups without blocking compatible queued work", () => {
    const { store, runtime, peer } = setup();
    const routed = store.createAgent({ name: "Model routed", provider: "codex", model: "peer-only" });
    const waiting = store.createTask({ agentId: routed.id, prompt: "Needs peer model" });
    const compatible = store.createAgent({ name: "Compatible", provider: "codex", model: "common" });
    const runnable = store.createTask({ agentId: compatible.id, prompt: "Can run here" });
    expect(store.claimTask(runtime.id)?.id).toBe(runnable.id);
    expect(store.getTask(waiting.id)?.status).toBe("queued");
    expect(store.claimTask(peer.id)?.id).toBe(waiting.id);
  });

  it("matches thinking requirements even when the Runtime default model is used", () => {
    const { store, runtime, peer } = setup();
    const agent = store.createAgent({ name: "Thinking routed", provider: "codex", thinkingLevel: "high" });
    const task = store.createTask({ agentId: agent.id, prompt: "Needs high thinking" });
    expect(store.claimTask(peer.id)).toBeNull();
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });

  it("rechecks model capabilities after enqueue and keeps fixed groups bounded", () => {
    const { store, runtime, peer } = setup();
    const group = store.listExecutionGroups("local").find(entry => entry.runtimeIds.includes(runtime.id))!;
    const fixed = store.createAgent({ name: "Fixed", provider: "codex", executionGroupId: group.id, model: "peer-only" });
    const fixedTask = store.createTask({ agentId: fixed.id, prompt: "Stay in group" });
    expect(store.claimTask(peer.id)).toBeNull();
    expect(store.claimTask(runtime.id)).toBeNull();
    store.updateRuntimeModels(runtime.id, [{ id: "peer-only", label: "Peer", provider: "openai", default: true }]);
    expect(store.claimTask(runtime.id)?.id).toBe(fixedTask.id);
  });

  for (const provider of ["codex", "claude"] as const) {
    it(`preserves reported ${provider} reasoning through custom connections, group validation and dispatch`, async () => {
      const { store, app, request } = setup();
      const runtime = store.registerRuntime({ name: "Custom reasoning", provider, executionGroupId: "custom-group", metadata: { [`${provider}_profiles`]: 1 } });
      const profile = { name: "custom", base_url: "https://example.com/v1", model: "custom-model", env_key: provider === "codex" ? "REMI_CODEX_KEY" : "REMI_CLAUDE_KEY" };
      const configure = () => provider === "codex" ? store.setRuntimeCodexProfile(runtime.id, profile) : store.setRuntimeClaudeProfile(runtime.id, profile);
      const savedProfile = configure()!;
      store.updateRuntimeModels(runtime.id, [
        { id: "custom-model", label: "Custom model", provider, default: true, thinking: { supportedLevels: [{ value: "high", label: "High" }], defaultLevel: "high" } },
        { id: "alternative-model", label: "Alternative", provider, default: false, thinking: { supportedLevels: [{ value: "high", label: "High" }] } },
      ], savedProfile);
      for (const query of [`runtime_id=${runtime.id}`, "execution_group_id=custom-group"]) {
        const response = await app.request(`/api/models?workspace_id=local&${query}`);
        expect(response.status).toBe(200);
        const { providers } = await response.json();
        expect(providers[0].models.map((model: { default?: boolean }) => ({ ...model, default: model.default === true }))).toEqual([{
          id: "custom-model", label: "Custom model", provider, default: true,
          thinking: { supported_levels: [{ value: "high", label: "High" }], default_level: "high" },
          // Reported by the Runtime itself, so the catalog names it as that source
          // rather than leaving the levels unattributed.
          thinking_source: "runtime",
        }, {
          id: "alternative-model", label: "Alternative", provider, default: false,
          thinking: { supported_levels: [{ value: "high", label: "High" }] },
          thinking_source: "runtime",
        }]);
      }
      const response = await request("/api/agents", { name: "Reasoning", execution_group_id: "custom-group", model: "alternative-model", thinking_level: "high" });
      expect(response.status).toBe(201);
      const agent = await response.json();
      const task = store.createTask({ agentId: agent.id, prompt: "Use the configured connection" });
      const claimed = store.claimTask(runtime.id)!;
      expect(claimed.id).toBe(task.id);
      expect((provider === "codex" ? claimed.codexProfile : claimed.claudeProfile)?.model).toBe("alternative-model");
      // Changing a connection must invalidate capabilities from its previous endpoint.
      configure();
      expect(store.listRuntimeModels(runtime.id)[0]?.thinking).toBeUndefined();
      store.updateRuntimeModels(runtime.id, [{ id: "different-model", label: "Different", provider, default: true, thinking: { supportedLevels: [{ value: "high", label: "High" }] } }]);
      expect(store.listRuntimeModels(runtime.id)[0]?.thinking).toBeUndefined();
    });
  }

  it("restores cross-machine scheduling when an agent leaves its execution group", async () => {
    const { store, runtime, peer, request } = setup();
    const group = store.listExecutionGroups("local").find((entry) => entry.runtimeIds.includes(runtime.id))!;
    const agent = store.createAgent({ name: "Pooled", provider: "codex", executionGroupId: group.id });
    expect((await request(`/api/agents/${agent.id}`, { execution_group_id: null }, "PUT")).status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ runtimeId: null, executionGroupId: null });
    const task = store.createTask({ agentId: agent.id, prompt: "Run on another machine" });
    expect(store.claimTask(peer.id)?.id).toBe(task.id);
  });

  it("lists separate default machine/type groups and exposes membership in Runtime responses", async () => {
    const { runtime, peer, app } = setup();
    const response = await app.request("/api/execution-groups?workspace_id=local");
    expect(response.status).toBe(200);
    const { groups } = await response.json();
    expect(groups).toHaveLength(2);
    expect(groups.map((group: { runtime_ids: string[] }) => group.runtime_ids)).toContainEqual([runtime.id]);
    expect(groups.map((group: { runtime_ids: string[] }) => group.runtime_ids)).toContainEqual([peer.id]);
    const runtimes = await (await app.request("/api/runtimes")).json();
    expect(runtimes.find((item: { id: string }) => item.id === runtime.id)).toMatchObject({ execution_group_id: null, execution_group_ids: [groups.find((group: { runtime_ids: string[] }) => group.runtime_ids.includes(runtime.id)).id] });
  });

  it("joins a custom group via both PATCH surfaces and restores default membership with null", async () => {
    const { store, runtime, peer, app, request } = setup();
    expect((await request(`/api/runtimes/${runtime.id}`, { name: "Renamed", execution_group_id: "shared" }, "PATCH")).status).toBe(200);
    expect((await request(`/api/multiremi/runtimes/${peer.id}`, { execution_group_id: "shared" }, "PATCH")).status).toBe(200);
    expect(store.getRuntime(runtime.id)?.name).toBe("Renamed");
    const { groups } = await (await app.request("/api/execution-groups")).json();
    expect(groups).toEqual([{ id: "shared", workspace_id: "local", name: "shared", provider: "codex", runtime_ids: [runtime.id, peer.id], online_runtime_count: 2, is_default: false }]);
    expect((await request(`/api/runtimes/${peer.id}`, { execution_group_id: null }, "PATCH")).status).toBe(200);
    expect(store.getRuntime(peer.id)?.executionGroupId).toBeNull();
    expect(store.getExecutionGroup("shared", "local")?.runtimeIds).toEqual([runtime.id]);
  });

  it("rejects incompatible providers, reserved ids and malformed custom group values before mutation", async () => {
    const { store, runtime, request, join } = setup();
    join();
    const claude = store.registerRuntime({ name: "Claude", provider: "claude" });
    const any = store.registerRuntime({ name: "Any", provider: "any" });
    for (const [id, value] of [[claude.id, "shared"], [runtime.id, "eg_reserved"], [runtime.id, ""], [runtime.id, 123], [any.id, "another"]]) {
      expect((await request(`/api/runtimes/${id}`, { execution_group_id: value }, "PATCH")).status).toBe(400);
    }
    const created = await request("/api/multiremi/runtimes", { name: "Incompatible", provider: "claude", execution_group_id: "shared" });
    expect(created.status).toBe(400);
    expect(store.listRuntimes().some((candidate) => candidate.name === "Incompatible")).toBe(false);
  });

  for (const path of ["/api/agents", "/api/multiremi/agents", "/api/agents/from-template", "/api/multiremi/agents/from-template", "/api/multiremi/agents/default"]) {
    it(`binds a group without a machine pin via ${path}`, async () => {
      const { store, request, join } = setup();
      join();
      const response = await request(path, { name: "Grouped", execution_group_id: "shared", template_slug: "summarizer" });
      expect(response.status).toBe(201);
      const body = await response.json();
      const agent = store.getAgent((body.agent ?? body).id)!;
      expect(agent).toMatchObject({ executionGroupId: "shared", runtimeId: null, provider: "codex" });
      const wire = await (await createMultiremiApp({ store }).request(`/api/agents/${agent.id}`)).json();
      expect(wire.execution_group_id).toBe("shared");
    });
  }

  it("clears a pin and stale selection when selecting a group, and preserves the group on metadata updates", async () => {
    const { store, runtime, request, join } = setup();
    join();
    const agent = store.createAgent({ name: "Pinned", provider: "codex", runtimeId: runtime.id, model: "common", thinkingLevel: "high" });
    expect((await request(`/api/agents/${agent.id}`, { execution_group_id: "shared" }, "PUT")).status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ runtimeId: null, executionGroupId: "shared", model: "", thinkingLevel: "" });
    expect((await request(`/api/agents/${agent.id}`, { name: "Renamed" }, "PUT")).status).toBe(200);
    expect(store.getAgent(agent.id)?.executionGroupId).toBe("shared");
  });

  it("intersects models and effort across offline and online members and validates agent selections", async () => {
    const { store, peer, app, request, join } = setup();
    join();
    store.setRuntimeOffline(peer.id);
    const { providers } = await (await app.request("/api/models?execution_group_id=shared")).json();
    expect(providers[0].online_runtime_count).toBe(1);
    expect(providers[0].models.map((model: { id: string }) => model.id)).toEqual(["common"]);
    expect(providers[0].models[0].thinking.supported_levels.map((level: { value: string }) => level.value)).toEqual(["low"]);
    expect((await request("/api/agents", { name: "Bad model", execution_group_id: "shared", model: "peer-only" })).status).toBe(400);
    expect((await request("/api/agents", { name: "Bad effort", execution_group_id: "shared", model: "common", thinking_level: "high" })).status).toBe(400);
    expect((await request("/api/agents", { name: "Good", execution_group_id: "shared", model: "common", thinking_level: "low" })).status).toBe(201);
  });

  it("does not combine incompatible fixed connections, while runtime defaults remain selectable", async () => {
    const { store, runtime, peer, app, request, join } = setup();
    join();
    store.setRuntimeCodexProfile(runtime.id, { name: "first", base_url: "https://first.example/v1", model: "first", env_key: "REMI_CODEX_FIRST" });
    store.setRuntimeCodexProfile(peer.id, { name: "second", base_url: "https://second.example/v1", model: "second", env_key: "REMI_CODEX_SECOND" });
    expect((await (await app.request("/api/models?execution_group_id=shared")).json()).providers[0].models).toEqual([]);
    expect((await request("/api/agents", { name: "Default", execution_group_id: "shared" })).status).toBe(201);
    expect((await request("/api/agents", { name: "Wrong", execution_group_id: "shared", model: "first" })).status).toBe(400);
  });

  it("uses the managed agent owner for group and model queries, with workspace and access checks", async () => {
    const { store, runtime, app, request } = setup();
    store.updateRuntime(runtime.id, { ownerId: "other", executionGroupId: "others" });
    const agent = store.createAgent({ name: "Other owner", provider: "codex", ownerId: "other" });
    const defaultGroups = await (await app.request("/api/execution-groups")).json();
    expect(defaultGroups.groups.some((group: { id: string }) => group.id === "others")).toBe(false);
    expect((await app.request("/api/models?execution_group_id=others")).status).toBe(403);
    const managed = await (await app.request(`/api/execution-groups?agent_id=${agent.id}`)).json();
    expect(managed.groups.some((group: { id: string }) => group.id === "others")).toBe(true);
    expect((await app.request(`/api/models?execution_group_id=others&agent_id=${agent.id}`)).status).toBe(200);
    const pooled = store.createAgent({ name: "Managed pool", provider: "codex", ownerId: "other" });
    store.updateRuntime(runtime.id, { models: [{ id: "owner-only", label: "Owner only", provider: "codex", default: true }] });
    const poolCatalog = await (await app.request(`/api/models?agent_id=${pooled.id}`)).json();
    expect(poolCatalog.providers[0].models.map((model: { id: string }) => model.id)).toEqual(["owner-only"]);
    expect((await app.request("/api/execution-groups?agent_id=missing")).status).toBe(404);
    expect((await request(`/api/agents/${agent.id}`, { execution_group_id: "others" }, "PUT")).status).toBe(200);
  });
  it("rejects another member using agent_id to inspect private group capabilities", async () => {
    const { store, runtime } = setup();
    store.createWorkspaceMember({ id: "group-owner", name: "Owner", role: "member" });
    store.createWorkspaceMember({ id: "group-outsider", name: "Outsider", role: "member" });
    store.updateRuntime(runtime.id, { ownerId: "group-owner", executionGroupId: "private-group" });
    const agent = store.createAgent({ name: "Private", provider: "codex", ownerId: "group-owner", executionGroupId: "private-group" });
    const { token } = await store.createAccessToken({ name: "Outsider", type: "pat", workspaceId: "local", userId: "group-outsider" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${token}` };
    // Private agents are hidden by the current main visibility policy.
    expect((await app.request(`/api/execution-groups?agent_id=${agent.id}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/models?execution_group_id=private-group&agent_id=${agent.id}`, { headers })).status).toBe(404);
  });

  it("revalidates a group model when changing the agent owner changes eligible members", async () => {
    const { store, peer, request, join } = setup();
    join();
    store.updateRuntime(peer.id, { ownerId: "other", models: [{ id: "other-model", label: "Other", provider: "openai", default: true }] });
    const agent = store.createAgent({ name: "Local", provider: "codex", ownerId: "local", executionGroupId: "shared", model: "common" });
    const changed = await request(`/api/agents/${agent.id}`, { owner_id: "other" }, "PUT");
    expect(changed.status).toBe(400);
    expect(store.getAgent(agent.id)?.ownerId).toBe("local");
  });

});
