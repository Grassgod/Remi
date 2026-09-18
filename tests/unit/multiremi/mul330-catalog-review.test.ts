import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import type { MultiremiRuntimeModel, MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { catalogAllowsModel, runtimeTargetModelCatalog, workspaceRuntimeModelCatalog } from "@multiremi/store/runtime-model-catalog.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const thinking = (level: string): MultiremiRuntimeModelThinking => ({
  status: "supported", supportedLevels: [{ value: level, label: level }], defaultLevel: level,
});
const report = (id: string, level: string, status: "ready" | "error"): MultiremiRuntimeModel => ({
  id, label: id, provider: "openai", default: true, thinking: thinking(level),
  catalog: status === "error" ? { status, error: "Native catalog HTTP 503" } : { status },
});

function setup() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "codex", {
    fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
    tokenOp: "set", authToken: "fixture-token",
  });
  store.saveGatewayModels("local", "codex", { sourceRevision: revision, nativeCatalogStatus: "ready", models: [
    { id: "gateway-only", label: "Gateway", thinking: thinking("high") },
    { id: "bundled-model", label: "Bundled", thinking: thinking("high") },
  ] });
  const fallback = store.registerRuntime({
    id: "fallback", name: "Fallback", provider: "codex", workspaceId: "local", executionGroupId: "mixed-group",
    models: [report("bundled-model", "low", "error")],
  });
  const fleet = () => workspaceRuntimeModelCatalog(store, "local", store.listRuntimes(), "local")[0]!;
  return { store, fallback, fleet, app: createMultiremiApp({ store }) };
}

function addCustom(store: ReturnType<typeof createLocalStore>) {
  const runtime = store.registerRuntime({
    id: "custom", name: "Custom", provider: "codex", workspaceId: "local", metadata: { codex_profiles: 1 },
  });
  const profile = { name: "custom", base_url: "https://custom.invalid/v1", model: "custom-only", env_key: "REMI_CODEX_FIXTURE_KEY" };
  const configured = store.setRuntimeCodexProfile(runtime.id, profile);
  store.updateRuntimeModels(runtime.id, [{
    id: "custom-only", label: "Custom", provider: "openai", default: true, thinking: thinking("medium"),
  }], configured);
  return store.getRuntime(runtime.id)!;
}

describe("MUL-330 independent mixed-runtime catalog regression", () => {
  it("persists native load provenance independently from usable bundled reasoning", () => {
    const { store, fallback } = setup();
    expect(store.listRuntimeModels(fallback.id)[0]).toMatchObject(report("bundled-model", "low", "error"));
    const catalog = runtimeTargetModelCatalog(store, "local", store.getRuntime(fallback.id)!)[0]!;
    expect(catalogAllowsModel(catalog, "bundled-model")).toBe(true);
    expect(catalogAllowsModel(catalog, "gateway-only")).toBe(false);
    expect(catalog.models.find(model => model.id === "bundled-model")?.thinking?.default_level).toBe("low");
  });

  it("does not let a custom runtime erase a failed native runtime's unavailable members", async () => {
    const { store, fleet, app } = setup();
    addCustom(store);
    const catalog = fleet();
    expect(catalogAllowsModel(catalog, "gateway-only")).toBe(false);
    expect(catalogAllowsModel(catalog, "custom-only")).toBe(true);
    expect(catalog.models.find(model => model.id === "bundled-model")?.thinking?.default_level).toBe("low");
    const response = await app.request("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unavailable", provider: "codex", model: "gateway-only" }),
    });
    expect(response.status).toBe(400);
  });

  it("keeps custom connections selectable while the workspace native snapshot is unknown", async () => {
    const { store, fleet, app } = setup();
    const revision = store.getRelayConfigForDaemon("local").codex!.revision;
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [{ id: "gateway-only", label: "Gateway" }] });
    const custom = addCustom(store);
    expect(catalogAllowsModel(fleet(), "gateway-only")).toBe(false);
    expect(catalogAllowsModel(fleet(), "custom-only")).toBe(true);
    const response = await app.request("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Custom", provider: "codex", model: "custom-only", thinking_level: "medium" }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const agent = store.getAgent((await response.json()).id)!;
    expect(store.runtimeCanRunAgent(custom, agent)).toBe(true);
  });

  it("uses the actual fallback model's reasoning when another native runtime is healthy", async () => {
    const { store, fleet, app } = setup();
    store.registerRuntime({ id: "healthy", name: "Healthy", provider: "codex", workspaceId: "local", models: [report("gateway-only", "high", "ready")] });
    const catalog = fleet();
    expect(catalogAllowsModel(catalog, "gateway-only")).toBe(true);
    expect(catalogAllowsModel(catalog, "bundled-model")).toBe(true);
    expect(catalog.models.find(model => model.id === "bundled-model")?.thinking?.default_level).toBe("low");
    const response = await app.request("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bundled", provider: "codex", model: "bundled-model", thinking_level: "low" }),
    });
    expect(response.status).toBe(201);
  });

  it("does not let a legacy failure displace an actual selectable member with unknown reasoning", () => {
    const { store, fallback, fleet } = setup();
    store.updateRuntimeModels(fallback.id, [{
      id: "gateway-only", label: "Legacy report", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "Old catalog unavailable" },
    }]);
    store.registerRuntime({ id: "healthy", name: "Healthy", provider: "codex", workspaceId: "local", models: [{
      id: "gateway-only", label: "Actual selectable member", provider: "openai", default: true,
      catalog: { status: "ready" }, thinking: { status: "unknown", supportedLevels: [] },
    }] });
    expect(catalogAllowsModel(fleet(), "gateway-only")).toBe(true);
  });

  it("retains actual bundled-only members when another runtime loaded a native catalog", () => {
    const { store, fallback, fleet } = setup();
    store.updateRuntimeModels(fallback.id, [report("bundled-only", "low", "error")]);
    store.registerRuntime({ id: "healthy", name: "Healthy", provider: "codex", workspaceId: "local", models: [report("gateway-only", "high", "ready")] });
    expect(catalogAllowsModel(fleet(), "bundled-only")).toBe(true);
    const saved = store.createAgent({ name: "Bundled only", provider: "codex", model: "bundled-only", thinkingLevel: "low" });
    expect(store.runtimeCanRunAgent(store.getRuntime(fallback.id)!, saved)).toBe(true);
  });

  it("keeps execution groups as an intersection of actual available members", async () => {
    const { store, fleet, app } = setup();
    store.registerRuntime({ id: "healthy", name: "Healthy", provider: "codex", workspaceId: "local", executionGroupId: "mixed-group", models: [report("gateway-only", "high", "ready")] });
    expect(catalogAllowsModel(fleet(), "gateway-only")).toBe(true);
    const group = executionGroupModelCatalog(store, "local", "mixed-group", "local")[0]!;
    expect(catalogAllowsModel(group, "gateway-only")).toBe(false);
    const response = await app.request("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group unavailable", execution_group_id: "mixed-group", model: "gateway-only" }),
    });
    expect(response.status).toBe(400);
  });
  it("blocks unverified legacy error members without effort even beside a healthy peer", async () => {
    const { store, fallback, fleet, app } = setup();
    store.updateRuntimeModels(fallback.id, [{
      id: "gateway-only", label: "Legacy inventory", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "Legacy catalog failure" },
    }]);
    store.registerRuntime({ id: "healthy", name: "Healthy", provider: "codex", workspaceId: "local", models: [report("bundled-model", "high", "ready")] });
    expect(catalogAllowsModel(fleet(), "gateway-only")).toBe(false);
    const response = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Legacy failure", provider: "codex", model: "gateway-only" }) });
    expect(response.status).toBe(400);
    const saved = store.createAgent({ name: "Saved legacy", provider: "codex", model: "gateway-only" });
    const task = store.createTask({ agentId: saved.id, prompt: "Wait for actual execution member" });
    expect(store.claimTask(fallback.id)).toBeNull();
    expect(store.claimTask("healthy")).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("uses actual fallback membership even when gateway inventory discovery is disabled", async () => {
    const { store, fallback, app } = setup();
    store.setRelayModelDiscovery("local", false);
    const blocked = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unlisted", provider: "codex", model: "gateway-only", runtime_id: fallback.id }) });
    expect(blocked.status).toBe(400);
    const saved = store.createAgent({ name: "Saved unlisted", provider: "codex", model: "gateway-only" });
    const task = store.createTask({ agentId: saved.id, prompt: "Cannot execute" });
    expect(store.claimTask(fallback.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    const allowed = store.createAgent({ name: "Actual fallback", provider: "codex", model: "bundled-model", thinkingLevel: "low" });
    const runnable = store.createTask({ agentId: allowed.id, prompt: "Actual GPT" });
    expect(store.claimTask(fallback.id)?.id).toBe(runnable.id);
  });

});
