import { codexNativeModel } from "../../fixtures/codex-native-catalog.js";
import { refreshStaleGatewayModels } from "@multiremi/relay/discovery.js";
import { runtimeModelsWithCatalogError } from "@multiremi/worker/daemon.js";
import { loadCodexModelCatalog } from "@daemon/agent-runtime/relay-sync.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { discoverGatewayModels } from "@multiremi/relay/discovery.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = { "Content-Type": "application/json" };
const inventory = ["executable-model", "inventory-only-route"];

function setup() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  store.upsertRelayConfig("local", "codex", {
    fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
    tokenOp: "set", authToken: "fixture-token",
  });
  const runtime = store.registerRuntime({
    name: "Catalog runtime", provider: "codex", workspaceId: "local",
    executionGroupId: "catalog-group", maxConcurrency: 8,
    // A stale runtime report must not resurrect a member removed by the native catalog.
    models: inventory.map(id => ({ id, label: id, provider: "openai", default: id === "executable-model" })),
  });
  const app = createMultiremiApp({ store });
  const discover = (nativeIds = ["executable-model"], nativeStatus = 200) => discoverGatewayModels(
    store, "local", "codex", async url => url.endsWith("/backend-api/codex/models")
      ? { status: nativeStatus, text: JSON.stringify({ models: nativeIds.map(slug => codexNativeModel({
        slug, display_name: slug, visibility: "list", supported_in_api: true,
        default_reasoning_level: "high",
        supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort, description: "" })),
      })) }) }
      : { status: 200, text: JSON.stringify({ data: inventory.map(id => ({ id, display_name: id })) }) },
  );
  return { store, runtime, app, discover };
}

type Binding = "automatic" | "runtime" | "group";
const bindings = ["automatic", "runtime", "group"] as const;
function target(binding: Binding, runtimeId: string) {
  return binding === "runtime" ? { runtimeId } : binding === "group" ? { executionGroupId: "catalog-group" } : {};
}

describe("Codex native model membership through API and dispatch", () => {
  it("exposes only native members for workspace, Runtime, execution group and saved Agent catalogs", async () => {
    const { store, runtime, app, discover } = setup();
    const saved = store.createAgent({ name: "Previously saved route", provider: "codex", model: "inventory-only-route", thinkingLevel: "max" });
    await discover();

    for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=catalog-group", `?agent_id=${saved.id}`]) {
      const response = await app.request(`/api/models${query}`);
      expect(response.status).toBe(200);
      const { providers } = await response.json();
      const codex = providers.find((provider: any) => provider.provider === "codex");
      expect(codex.model_catalog_status).toBe("ready");
      expect(codex.models.map((model: any) => model.id)).toEqual(["executable-model"]);
      expect(codex.models[0].thinking).toEqual({
        status: "supported", default_level: "high",
        supported_levels: ["low", "high", "max"].map(value => ({ value, label: value })),
      });
    }
    const readback = await (await app.request(`/api/agents/${saved.id}`)).json();
    expect(readback).toMatchObject({ model: "inventory-only-route", thinking_level: "max" });
    expect(store.getAgent(saved.id)).toMatchObject({ model: "inventory-only-route", thinkingLevel: "max" });
  });

  for (const binding of bindings) {
    it(`rejects a new ${binding} Agent selecting a nonmember without an effort override on both API routes`, async () => {
      const { app, runtime, discover } = setup();
      await discover();
      for (const path of ["/api/agents", "/api/multiremi/agents"]) {
        const response = await app.request(path, { method: "POST", headers, body: JSON.stringify({
          name: "Cannot execute", provider: "codex", model: "inventory-only-route", ...target(binding, runtime.id),
        }) });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain("inventory-only-route");
        if (binding !== "group") expect(body.code).toBe("model_not_in_execution_catalog");
      }
    });

    it(`preserves saved ${binding} values through unrelated edits but rejects changing to a nonmember`, async () => {
      const { store, app, runtime, discover } = setup();
      const saved = store.createAgent({ name: "Saved route", provider: "codex", model: "inventory-only-route", thinkingLevel: "max", ...target(binding, runtime.id) });
      const valid = store.createAgent({ name: "Valid model", provider: "codex", model: "executable-model", ...target(binding, runtime.id) });
      await discover();

      for (const body of [
        { name: "Metadata only" },
        { name: "Resent saved selection", model: "inventory-only-route", thinking_level: "max" },
      ]) {
        const response = await app.request(`/api/agents/${saved.id}`, { method: "PUT", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ name: body.name, model: "inventory-only-route", thinking_level: "max" });
      }
      const rejected = await app.request(`/api/multiremi/agents/${valid.id}`, { method: "PATCH", headers,
        body: JSON.stringify({ model: "inventory-only-route" }),
      });
      expect(rejected.status).toBe(400);
      expect(store.getAgent(valid.id)?.model).toBe("executable-model");
      expect(store.getAgent(saved.id)).toMatchObject({ model: "inventory-only-route", thinkingLevel: "max" });
    });

    it(`blocks ${binding} nonmember dispatch without effort, permits other work and resumes when the native catalog adds it`, async () => {
      const { store, app, runtime, discover } = setup();
      const saved = store.createAgent({ name: "Wait for native membership", provider: "codex", model: "inventory-only-route", ...target(binding, runtime.id) });
      const allowed = store.createAgent({ name: "Executable", provider: "codex", model: "executable-model", ...target(binding, runtime.id) });
      const dispatches: string[] = [];
      store.onTaskEvent(({ type, task }) => { if (type === "task:dispatch") dispatches.push(task.id); });
      await discover();

      const created = await app.request("/api/multiremi/tasks", { method: "POST", headers,
        body: JSON.stringify({ agentId: saved.id, prompt: "Must retain requested model", priority: 100 }),
      });
      expect(created.status).toBe(201);
      const { task: waiting } = await created.json();
      expect(store.runtimeCanRunAgent(runtime, saved)).toBe(false);
      const emptyClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
      expect(emptyClaim.status).toBe(200);
      expect((await emptyClaim.json()).task).toBeNull();
      expect(store.getTask(waiting.id)?.status).toBe("queued");
      expect(dispatches).toEqual([]);

      const runnable = store.createTask({ agentId: allowed.id, prompt: "Do not starve behind unavailable model" });
      expect(store.claimTask(runtime.id)?.id).toBe(runnable.id);
      expect(store.getTask(waiting.id)?.status).toBe("queued");
      expect(dispatches).toEqual([runnable.id]);

      await discover(inventory);
      expect(store.runtimeCanRunAgent(runtime, saved)).toBe(true);
      const resumed = store.claimTask(runtime.id);
      expect(resumed?.id).toBe(waiting.id);
      expect(resumed?.agent?.model).toBe("inventory-only-route");
      expect(resumed?.agent?.thinkingLevel).toBeFalsy();
      store.startTask(waiting.id);
      await discover();
      store.heartbeatRuntime(runtime.id);
      expect(store.getTask(waiting.id)?.status).toBe("running");
      expect(store.getAgent(saved.id)?.model).toBe("inventory-only-route");
      expect(store.getAgent(saved.id)?.thinkingLevel).toBeFalsy();
    });
  }

  it("requeues a stale dispatch when native membership disappears before execution", async () => {
    const { store, runtime, discover } = setup();
    await discover(inventory);
    const agent = store.createAgent({ name: "Lost claim response", provider: "codex", model: "inventory-only-route" });
    const task = store.createTask({ agentId: agent.id, prompt: "Not started" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    await discover();
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.getAgent(agent.id)?.model).toBe("inventory-only-route");
  });

  for (const binding of bindings) for (const serverFailed of [false, true]) {
    it(`keeps display inventory but only dispatches ACP-proven bundled members for ${binding} (server failure=${serverFailed})`, async () => {
      const { store, runtime, app, discover } = setup();
      await discover(inventory);
      if (serverFailed) await discover([], 503);
      const fallbackModels = runtimeModelsWithCatalogError([{
        id: "bundled-gpt", label: "Bundled GPT", provider: "openai", default: true,
        thinking: { status: "supported", supportedLevels: [{ value: "high", label: "high" }], defaultLevel: "high" },
      }], "Codex model catalog HTTP 503");
      store.updateRuntimeModels(runtime.id, fallbackModels);
      const refreshed = store.getRuntime(runtime.id)!;
      const saved = store.createAgent({ name: "Saved gateway model", provider: "codex", model: "inventory-only-route", ...target(binding, runtime.id) });
      const waiting = store.createTask({ agentId: saved.id, prompt: "Do not dispatch an unavailable model", priority: 100 });
      const dispatches: string[] = [];
      store.onTaskEvent(({ type, task }) => { if (type === "task:dispatch") dispatches.push(task.id); });
      for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=catalog-group", `?agent_id=${saved.id}`]) {
        const { providers } = await (await app.request(`/api/models${query}`)).json();
        const codex = providers.find((provider: any) => provider.provider === "codex");
        expect(codex.model_catalog_status).toBe("error");
        const unavailable = codex.models.find((model: any) => model.id === "inventory-only-route");
        expect(unavailable.execution_status).toBe("unavailable");
        expect(unavailable.thinking).toMatchObject({ status: "error", supported_levels: [] });
        expect(codex.models.find((model: any) => model.id === "bundled-gpt")).toMatchObject({ execution_status: "available",
          thinking: { status: "supported", default_level: "high", supported_levels: [{ value: "high", label: "high" }] } });
      }
      for (const path of ["/api/agents", "/api/multiremi/agents"]) {
        const rejected = await app.request(path, { method: "POST", headers, body: JSON.stringify({
          name: "Cannot execute fallback", provider: "codex", model: "inventory-only-route", ...target(binding, runtime.id),
        }) });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).code).toBe("model_not_in_execution_catalog");
      }
      expect(store.runtimeCanRunAgent(refreshed, saved)).toBe(false);
      const emptyClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
      expect((await emptyClaim.json()).task).toBeNull();
      expect(store.getTask(waiting.id)?.status).toBe("queued");
      expect(dispatches).toEqual([]);
      const updated = await app.request(`/api/agents/${saved.id}`, { method: "PUT", headers, body: JSON.stringify({ name: "Unrelated edit" }) });
      expect(updated.status).toBe(200);
      expect(store.getAgent(saved.id)?.model).toBe("inventory-only-route");
      for (const thinking_level of [undefined, "high"]) {
        const allowed = await app.request("/api/agents", { method: "POST", headers, body: JSON.stringify({
          name: `Bundled GPT ${thinking_level ?? "default"}`, provider: "codex", model: "bundled-gpt", thinking_level, ...target(binding, runtime.id),
        }) });
        expect(allowed.status).toBe(201);
        const agent = await allowed.json();
        const task = store.createTask({ agentId: agent.id, prompt: "Run actual fallback member" });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        store.heartbeatRuntime(runtime.id);
        expect(store.getTask(task.id)?.status).toBe("running");
      }
      store.updateRuntimeModels(runtime.id, inventory.map(id => ({ id, label: id, provider: "openai", default: false,
        catalog: { status: "ready" as const } })));
      await discover(inventory);
      expect(store.claimTask(runtime.id)?.id).toBe(waiting.id);
    });
  }

  it("rejects the same incomplete native directory on server and daemon and never dispatches its invented member", async () => {
    const { store, runtime, app } = setup();
    const partial = { models: [{ slug: "partial-native", display_name: "Partial", visibility: "list", supported_in_api: true,
      default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high", description: "High" }] }] };
    await discoverGatewayModels(store, "local", "codex", async url => ({ status: 200, text: JSON.stringify(
      url.endsWith("/backend-api/codex/models") ? partial : { data: [{ id: "partial-native" }] },
    ) }));
    const daemon = await loadCodexModelCatalog('model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"', "fixture-token", async () => ({ status: 200, text: JSON.stringify(partial) }));
    expect(daemon.status).toBe("error");
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("error");
    const catalog = (await (await app.request("/api/models")).json()).providers[0];
    expect(catalog).toMatchObject({ model_catalog_status: "error", models: [{ id: "partial-native", execution_status: "unavailable" }] });
    for (const binding of bindings) {
      const selected = { name: `Incomplete ${binding}`, provider: "codex", model: "partial-native", ...target(binding, runtime.id) };
      const rejected = await app.request("/api/agents", { method: "POST", headers, body: JSON.stringify(selected) });
      expect(rejected.status).toBe(400);
      const saved = store.createAgent(selected);
      const task = store.createTask({ agentId: saved.id, prompt: "Must wait" });
      expect(store.runtimeCanRunAgent(runtime, saved)).toBe(false);
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(store.getTask(task.id)?.status).toBe("queued");
    }
  });

  it("never treats an unrefreshed legacy snapshot as authority while discovery remains pending", async () => {
    const { store, runtime, app, discover } = setup();
    const revision = store.getRelayConfigForDaemon("local").codex!.revision;
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: inventory.map(id => ({ id, label: id })) });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    refreshStaleGatewayModels(store, "local", async url => {
      await pending;
      return { status: 200, text: JSON.stringify(url.endsWith("/backend-api/codex/models")
        ? { models: [codexNativeModel({ slug: "executable-model" })] } : { data: inventory.map(id => ({ id })) }) };
    });
    try {
      for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=catalog-group"]) {
        const codex = (await (await app.request(`/api/models${query}`)).json()).providers[0];
        expect(codex.model_catalog_status).toBe("unknown");
        expect(codex.models.every((model: any) => model.execution_status === "unknown")).toBe(true);
      }
      for (const binding of bindings) {
        const selection = { name: `Old inventory ${binding}`, provider: "codex", model: "inventory-only-route", ...target(binding, runtime.id) };
        const rejected = await app.request("/api/agents", { method: "POST", headers, body: JSON.stringify(selection) });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).code).toBe("model_execution_catalog_unknown");
        const saved = store.createAgent(selection);
        const waiting = store.createTask({ agentId: saved.id, prompt: "Wait for authoritative refresh" });
        expect(store.runtimeCanRunAgent(runtime, saved)).toBe(false);
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(store.getTask(waiting.id)?.status).toBe("queued");
      }
    } finally { release(); }
    await discover();
    const codex = (await (await app.request("/api/models")).json()).providers[0];
    expect(codex.model_catalog_status).toBe("ready");
    expect(codex.models.map((model: any) => model.id)).toEqual(["executable-model"]);
  });

  it("does not apply Codex native membership restrictions to Claude model selection or claims", async () => {
    const { store, app, discover } = setup();
    await discover();
    const claude = store.registerRuntime({ name: "Claude", provider: "claude", workspaceId: "local",
      models: [{ id: "opus", label: "Opus", provider: "anthropic", default: true }],
    });
    const response = await app.request("/api/agents", { method: "POST", headers,
      body: JSON.stringify({ name: "Claude alias", provider: "claude", model: "claude-custom-alias" }),
    });
    expect(response.status).toBe(201);
    const agent = await response.json();
    const task = store.createTask({ agentId: agent.id, prompt: "Keep Claude gateway behavior" });
    expect(store.claimTask(claude.id)?.id).toBe(task.id);
  });
});
