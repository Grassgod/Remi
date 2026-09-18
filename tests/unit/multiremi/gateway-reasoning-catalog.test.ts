import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { discoverGatewayModels } from "@multiremi/relay/discovery.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const reasoning = (values: string[], defaultLevel?: string): MultiremiRuntimeModelThinking => ({
  status: values.length ? "supported" : "unsupported",
  supportedLevels: values.map(value => ({ value, label: value })),
  ...(defaultLevel ? { defaultLevel } : {}),
});

function setup() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "codex", {
    fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
    tokenOp: "set", authToken: "test-key",
  });
  const runtime = store.registerRuntime({ name: "Reasoning runtime", provider: "codex", workspaceId: "local",
    executionGroupId: "reasoning-group", models: [
      { id: "deepseek-flash", label: "Old DeepSeek", provider: "openai", default: false, thinking: reasoning(["medium"], "medium") },
      { id: "gpt-runtime", label: "GPT", provider: "openai", default: true, thinking: reasoning(["low", "high"], "low") },
    ],
  });
  return { store, revision, runtime, app: createMultiremiApp({ store }) };
}

describe("gateway reasoning capability data flow", () => {
  it("exposes native membership and its authority consistently for workspace and Runtime catalogs", async () => {
    const { store, runtime, app } = setup();
    await discoverGatewayModels(store, "local", "codex", async url => ({ status: 200, text: JSON.stringify(
      url.endsWith("/backend-api/codex/models") ? { models: [
        { slug: "deepseek-flash", default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })) },
        { slug: "native-only", display_name: "Native only", supported_reasoning_levels: [] },
        { slug: "hidden-model", visibility: "hide" },
      ] } : { data: ["deepseek-flash", "inventory-only", "hidden-model"].map(id => ({ id })) },
    ) }));
    for (const query of ["", `?runtime_id=${runtime.id}`]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].model_catalog_status).toBe("ready");
      expect(providers[0].models.map((model: any) => model.id)).toEqual(["deepseek-flash", "native-only"]);
      expect(providers[0].models[0].thinking.default_level).toBe("high");
      expect(providers[0].models[0].thinking.supported_levels.map((level: any) => level.value)).toEqual(["low", "high", "max"]);
    }
  });

  it("does not restore bundled models when a successful native catalog has no selectable entries", async () => {
    const { store, runtime, app } = setup();
    await discoverGatewayModels(store, "local", "codex", async url => ({ status: 200, text: JSON.stringify(
      url.endsWith("/backend-api/codex/models")
        ? { models: [{ slug: "hidden-model", visibility: "hide" }] }
        : { data: [{ id: "inventory-only" }] },
    ) }));
    for (const query of ["", `?runtime_id=${runtime.id}`]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].model_catalog_status).toBe("ready");
      expect(providers[0].models).toEqual([]);
    }
  });

  it("keeps the ordinary list on native loading failure and clears authoritative membership", async () => {
    const { store, runtime, app } = setup();
    await discoverGatewayModels(store, "local", "codex", async url => url.endsWith("/backend-api/codex/models")
      ? { status: 503, text: "unavailable" }
      : { status: 200, text: JSON.stringify({ data: [{ id: "inventory-only" }, { id: "deepseek-flash" }] }) });
    for (const query of ["", `?runtime_id=${runtime.id}`]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].model_catalog_status).toBe("error");
      expect(providers[0].models.map((model: any) => model.id)).toEqual(["inventory-only", "deepseek-flash"]);
      expect(providers[0].models.every((model: any) => model.thinking.status === "error")).toBe(true);
    }
  });

  it("keeps custom profiles separate from a successful gateway execution catalog", async () => {
    const { store, revision, runtime, app } = setup();
    const profile = { name: "private", base_url: "https://private.example/v1", model: "profile-only", env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" as const };
    const custom = store.registerRuntime({ name: "Custom", provider: "codex", daemonId: "custom-daemon", workspaceId: "local", metadata: { codex_profiles: 1 } });
    store.setRuntimeCodexProfile(custom.id, profile);
    store.updateRuntimeModels(custom.id, [{ id: "profile-only", label: "Profile", provider: "codex", default: true, thinking: reasoning(["high"]) }], profile);
    // Even a stale native runtime report must not borrow a peer's custom-profile membership.
    store.updateRuntimeModels(runtime.id, [
      { id: "deepseek-flash", label: "DeepSeek", provider: "openai", default: true },
      { id: "profile-only", label: "Stale profile", provider: "openai", default: false },
    ]);
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, nativeCatalogStatus: "ready", models: [
      { id: "deepseek-flash", label: "Gateway", thinking: reasoning(["high", "max"], "high") },
    ] });
    const fleet = (await (await app.request("/api/models")).json()).providers[0];
    expect(fleet.model_catalog_status).toBe("ready");
    expect(fleet.models.map((model: any) => model.id).sort()).toEqual(["deepseek-flash", "profile-only"]);
    const gateway = (await (await app.request(`/api/models?runtime_id=${runtime.id}`)).json()).providers[0];
    expect(gateway.model_catalog_status).toBe("ready");
    expect(gateway.models.map((model: any) => model.id)).toEqual(["deepseek-flash"]);
    const privateCatalog = (await (await app.request(`/api/models?runtime_id=${custom.id}`)).json()).providers[0];
    expect(privateCatalog.model_catalog_status).toBeUndefined();
    expect(privateCatalog.models.map((model: any) => model.id)).toEqual(["profile-only"]);
    expect(privateCatalog.default_thinking.supported_levels.map((level: any) => level.value)).toEqual(["high"]);
  });

  it("uses gateway per-model capabilities and defaults for workspace, target, group validation and dispatch", async () => {
    const { store, runtime, app } = setup();
    await discoverGatewayModels(store, "local", "codex", async url => ({ status: 200, text: JSON.stringify(
      url.endsWith("/backend-api/codex/models") ? { models: [
        { slug: "deepseek-flash", default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })) },
        { slug: "gpt-runtime", default_reasoning_level: "high", supported_reasoning_levels: ["low", "high"].map(effort => ({ effort })) },
      ] } : { data: [{ id: "deepseek-flash", display_name: "DeepSeek Flash" }, { id: "gpt-runtime" }] },
    ) }));
    for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=reasoning-group"]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      const deepseek = providers[0].models.find((model: any) => model.id === "deepseek-flash");
      expect(deepseek.thinking).toEqual({ status: "supported", supported_levels: reasoning(["low", "high", "max"]).supportedLevels, default_level: "high" });
      expect(providers[0].models.find((model: any) => model.id === "gpt-runtime").thinking.default_level).toBe("high");
    }
    const createAgent = (thinking_level: string) => app.request("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reasoning", execution_group_id: "reasoning-group", model: "deepseek-flash", thinking_level }),
    });
    expect((await createAgent("medium")).status).toBe(400);
    const response = await createAgent("max");
    expect(response.status).toBe(201);
    const agent = await response.json();
    const task = store.createTask({ agentId: agent.id, prompt: "Use configured reasoning" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("max");
  });

  it("keeps unknown, unsupported and failure distinct and rejects unavailable effort", async () => {
    const { store, revision, runtime, app } = setup();
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
      { id: "unknown-model", label: "Unknown", thinking: { status: "unknown", supportedLevels: [] } },
      { id: "deepseek-flash", label: "Unsupported", thinking: reasoning([]) },
      { id: "failed-model", label: "Failed", thinking: { status: "error", supportedLevels: [], error: "catalog unavailable" } },
      { id: "gpt-runtime", label: "GPT", thinking: { status: "unknown", supportedLevels: [] } },
    ] });
    for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=reasoning-group"]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].models.map((model: any) => model.thinking?.status)).toEqual(["unknown", "unsupported", "error", "supported"]);
      expect(providers[0].models[3].thinking.default_level).toBe("low");
    }
    for (const model of ["unknown-model", "deepseek-flash", "failed-model"]) {
      const response = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, provider: "codex", model, thinking_level: "high" }) });
      expect(response.status).toBe(400);
    }
  });

  it("does not let gateway declarations hide a runtime catalog loading failure", async () => {
    const { store, revision, runtime, app } = setup();
    store.updateRuntimeModels(runtime.id, [{ id: "deepseek-flash", label: "DeepSeek", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "gateway catalog HTTP 503" },
    }]);
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
      { id: "deepseek-flash", label: "DeepSeek", thinking: reasoning(["low", "high", "max"], "high") },
    ] });
    for (const query of [`?runtime_id=${runtime.id}`, "?execution_group_id=reasoning-group"]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].models[0].thinking).toEqual({ status: "error", supported_levels: [], error: "gateway catalog HTTP 503" });
    }
    const response = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unavailable", execution_group_id: "reasoning-group", model: "deepseek-flash", thinking_level: "max" }) });
    expect(response.status).toBe(400);
  });

  it("preserves explicit empty runtime capability sets through persistence and API serialization", async () => {
    const { store, runtime, app } = setup();
    store.setRelayModelDiscovery("local", false);
    store.updateRuntimeModels(runtime.id, [{ id: "no-effort", label: "No effort", provider: "openai", default: true,
      thinking: { status: "unsupported", supportedLevels: [] },
    }]);
    expect(store.listRuntimeModels(runtime.id)[0].thinking).toEqual({ status: "unsupported", supportedLevels: [] });
    const { providers } = await (await app.request(`/api/models?runtime_id=${runtime.id}`)).json();
    expect(providers[0].models[0].thinking).toEqual({ status: "unsupported", supported_levels: [] });
  });

  it("applies a failed runtime catalog to gateway-only models absent from the bundled fallback", async () => {
    const { store, revision, runtime, app } = setup();
    store.updateRuntimeModels(runtime.id, [{ id: "gpt-bundled", label: "Bundled GPT", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "catalog request failed" },
    }]);
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
      { id: "deepseek-flash", label: "DeepSeek", thinking: reasoning(["low", "high", "max"], "high") },
    ] });
    const { providers } = await (await app.request(`/api/models?runtime_id=${runtime.id}`)).json();
    expect(providers[0].models[0].thinking).toEqual({ status: "error", supported_levels: [], error: "catalog request failed" });
    const agent = store.createAgent({ name: "No fallback model", provider: "codex", model: "deepseek-flash", thinkingLevel: "max" });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait for catalog" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("preserves provider-default loading failures across workspace, runtime and group catalogs", async () => {
    const { store, revision, runtime, app } = setup();
    store.updateRuntimeModels(runtime.id, [
      { id: "default", label: "Default", provider: "openai", default: true, providerDefault: true,
        thinking: { status: "error", supportedLevels: [], error: "catalog unavailable" } },
      { id: "deepseek-flash", label: "DeepSeek", provider: "openai", default: false, thinking: reasoning(["high"]) },
    ]);
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
      { id: "deepseek-flash", label: "DeepSeek", thinking: reasoning(["low", "high", "max"], "high") },
    ] });
    for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=reasoning-group"]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      expect(providers[0].default_thinking).toEqual({ status: "error", supported_levels: [], error: "catalog unavailable" });
    }
    const response = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Default unavailable", execution_group_id: "reasoning-group", thinking_level: "high" }) });
    expect(response.status).toBe(400);
  });

  it("never borrows Claude effort levels for gateway DeepSeek models", async () => {
    const { store, app } = setup();
    store.registerRuntime({ name: "Claude runtime", provider: "claude", workspaceId: "local", models: [
      { id: "opus", label: "Opus", provider: "anthropic", default: true, thinking: reasoning(["low", "high"], "high") },
    ] });
    const revision = store.upsertRelayConfig("local", "claude", { fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }), tokenOp: "set", authToken: "test-key" });
    store.saveGatewayModels("local", "claude", { sourceRevision: revision, models: [
      { id: "claude-opus-5", label: "Opus 5" }, { id: "deepseek-flash", label: "DeepSeek" },
    ] });
    const { providers } = await (await app.request("/api/models")).json();
    const claude = providers.find((provider: any) => provider.provider === "claude");
    expect(claude.models[0].thinking.supported_levels).toEqual(reasoning(["low", "high"]).supportedLevels);
    expect(claude.models[0].thinking.default_level).toBe("high");
    expect(claude.models[1].thinking).toBeUndefined();
  });

  for (const binding of ["automatic", "runtime", "group"] as const) {
    it(`blocks ${binding} task claims during capability failure and resumes after recovery without changing running tasks`, () => {
      const { store, revision, runtime } = setup();
      store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
        { id: "deepseek-flash", label: "DeepSeek", thinking: reasoning(["low", "high", "max"], "high") },
      ] });
      const agent = store.createAgent({ name: "Reasoning task", provider: "codex", model: "deepseek-flash", thinkingLevel: "max",
        ...(binding === "runtime" ? { runtimeId: runtime.id } : binding === "group" ? { executionGroupId: "reasoning-group" } : {}),
      });
      const task = store.createTask({ agentId: agent.id, prompt: "Wait for catalog" });
      const fail = () => store.updateRuntimeModels(runtime.id, [{ id: "deepseek-flash", label: "DeepSeek", provider: "openai", default: true,
        thinking: { status: "error", supportedLevels: [], error: "catalog HTTP 503" },
      }]);
      fail();
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(store.getTask(task.id)?.status).toBe("queued");
      store.updateRuntimeModels(runtime.id, [{ id: "deepseek-flash", label: "DeepSeek", provider: "openai", default: true,
        thinking: reasoning(["low", "high", "max"], "high"),
      }]);
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      fail();
      store.heartbeatRuntime(runtime.id);
      expect(store.getTask(task.id)?.status).toBe("running");
      expect(store.getAgent(agent.id)?.thinkingLevel).toBe("max");
    });
  }

  it("offers a successful fleet report while excluding failed machines from task claims", async () => {
    const { store, revision, runtime, app } = setup();
    store.updateRuntimeModels(runtime.id, [{ id: "deepseek-flash", label: "DeepSeek failed", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "catalog unavailable" },
    }]);
    const healthy = store.registerRuntime({ name: "Healthy runtime", provider: "codex", workspaceId: "local", models: [
      { id: "deepseek-flash", label: "DeepSeek loaded", provider: "openai", default: false, thinking: reasoning(["high", "max"], "high") },
    ] });
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [
      { id: "deepseek-flash", label: "DeepSeek", thinking: reasoning(["high", "max"], "high") },
    ] });
    const { providers } = await (await app.request("/api/models")).json();
    expect(providers[0].models[0].thinking.status).toBe("supported");
    const agent = store.createAgent({ name: "Automatic reasoning", provider: "codex", model: "deepseek-flash", thinkingLevel: "max" });
    const task = store.createTask({ agentId: agent.id, prompt: "Use a working catalog" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(healthy.id)?.id).toBe(task.id);
  });
});
