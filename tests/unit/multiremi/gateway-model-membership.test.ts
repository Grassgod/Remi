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
      ? { status: nativeStatus, text: JSON.stringify({ models: nativeIds.map(slug => ({
        slug, display_name: slug, visibility: "list", supported_in_api: true,
        default_reasoning_level: "high",
        supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })),
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

  it("keeps generic fallback models and the failure reason on catalog load failure, blocking only explicit effort", async () => {
    const { store, runtime, app, discover } = setup();
    await discover();
    await discover([], 503);
    for (const query of ["", `?runtime_id=${runtime.id}`, "?execution_group_id=catalog-group"]) {
      const { providers } = await (await app.request(`/api/models${query}`)).json();
      const codex = providers.find((provider: any) => provider.provider === "codex");
      expect(codex.model_catalog_status).toBe("error");
      expect(codex.models.map((model: any) => model.id)).toEqual(inventory);
      for (const model of codex.models) expect(model.thinking).toMatchObject({ status: "error", supported_levels: [], error: expect.stringContaining("503") });
    }
    const fallback = await app.request("/api/agents", { method: "POST", headers,
      body: JSON.stringify({ name: "Fallback preserved", provider: "codex", model: "inventory-only-route" }),
    });
    expect(fallback.status).toBe(201);
    const fallbackAgent = await fallback.json();
    const task = store.createTask({ agentId: fallbackAgent.id, prompt: "Existing fallback behavior" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const explicit = await app.request("/api/agents", { method: "POST", headers,
      body: JSON.stringify({ name: "No unchecked effort", provider: "codex", model: "executable-model", thinking_level: "max" }),
    });
    expect(explicit.status).toBe(400);
    const saved = store.createAgent({ name: "Saved effort", provider: "codex", model: "executable-model", thinkingLevel: "max" });
    const waiting = store.createTask({ agentId: saved.id, prompt: "Wait for capability recovery" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(waiting.id)?.status).toBe("queued");
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
