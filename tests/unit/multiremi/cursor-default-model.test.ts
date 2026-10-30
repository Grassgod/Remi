import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { agentAtTaskTarget } from "@multiremi/contracts/task-execution.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { catalogAllowsModel, runtimeTargetModelCatalog, workspaceRuntimeModelCatalog } from "@multiremi/store/runtime-model-catalog.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function model(id: string, levels: string[] = []): MultiremiRuntimeModel {
  return {
    id, label: id === "default" ? "Auto" : id, provider: "cursor", default: id === "default",
    ...(id === "default" ? { providerDefault: true } : {}),
    catalog: { status: "ready" },
    thinking: { status: levels.length ? "supported" : "unsupported",
      supportedLevels: levels.map(value => ({ value, label: value })),
      ...(levels.length ? { defaultLevel: levels.at(-1) } : {}),
    },
  };
}

function fixture(discovery = false) {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", discovery);
  const setDefault = (id: string) => store.upsertRelayConfig("local", "cursor", {
    fragment: JSON.stringify({ default_model: id }), tokenOp: "keep",
  });
  setDefault("grok-4.7");
  const runtime = store.registerRuntime({ name: "Cursor", provider: "cursor", workspaceId: "local", maxConcurrency: 4,
    models: [model("default"), model("grok-4.7", ["low", "high"]), model("other", ["low", "maximum"])],
  });
  const app = createMultiremiApp({ store });
  let sequence = 0;
  const create = (body: object) => app.request("/api/agents", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Cursor ${++sequence}`, provider: "cursor", ...body }),
  });
  return { store, runtime, setDefault, create };
}

describe("Cursor inherited model selection", () => {
  for (const discovery of [false, true]) {
    it(`uses the workspace model and its effort across catalogs with HTTP discovery ${discovery}`, async () => {
      const { store, runtime, create } = fixture(discovery);
      const catalogs = [
        workspaceRuntimeModelCatalog(store, "local", [runtime], "local")[0]!,
        runtimeTargetModelCatalog(store, "local", runtime)[0]!,
        executionGroupModelCatalog(store, "local", runtime.executionGroupIds![0]!, "local")[0]!,
      ];
      for (const catalog of catalogs) {
        expect(catalog.default_model).toBe("grok-4.7");
        expect(catalog.default_thinking).toMatchObject({ status: "supported", default_level: "high",
          supported_levels: [{ value: "low" }, { value: "high" }],
        });
        expect(catalog.models.find(entry => entry.default)?.id).toBe("grok-4.7");
        expect(catalog.models.find(entry => entry.id === "default")?.thinking).toMatchObject({ status: "unsupported", supported_levels: [] });
        expect(catalog.models.find(entry => entry.id === "other")?.thinking?.default_level).toBe("maximum");
      }
      for (const target of [{}, { runtime_id: runtime.id }, { execution_group_id: runtime.executionGroupIds![0] }]) {
        expect((await create({ ...target, model: "", thinking_level: "low" })).status).toBe(201);
        expect((await create({ ...target, model: "default", thinking_level: "low" })).status).toBe(400);
        expect((await create({ ...target, model: "default" })).status).toBe(201);
      }
      expect((await create({ model: "other", thinking_level: "maximum" })).status).toBe(201);
      expect((await create({ model: "", fallback_model: "grok-4.7" })).status).toBe(400);
    });
  }

  it("does not invent membership or effort for an unavailable configured model", async () => {
    const { store, runtime, setDefault, create } = fixture();
    setDefault("not-in-native-catalog");
    const catalog = runtimeTargetModelCatalog(store, "local", runtime)[0]!;
    expect(catalog.default_model).toBe("not-in-native-catalog");
    expect(catalog.models.some(entry => entry.default)).toBe(false);
    expect(catalog.default_thinking).toEqual({ status: "unknown", supported_levels: [] });
    expect(catalogAllowsModel(catalog, "")).toBe(false);
    expect((await create({ model: "" })).status).toBe(400);
    expect((await create({ model: "default" })).status).toBe(201);
    const waiting = store.createAgent({ name: "Inherited", provider: "cursor", model: "" });
    const explicit = store.createAgent({ name: "Auto", provider: "cursor", model: "default" });
    store.createTask({ agentId: waiting.id, prompt: "Wait for a capable Runtime" });
    const runnable = store.createTask({ agentId: explicit.id, prompt: "Use native Auto" });
    expect(store.runtimeSupportsAgentModel(runtime, waiting)).toBe(false);
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(runnable.id);
    expect(claimed.executionModel).toBe("default");
  });

  it("requires the inherited model in each execution group member and rejects failed catalogs", async () => {
    const { store, runtime, create } = fixture();
    store.updateRuntime(runtime.id, { executionGroupId: "cursor-group" });
    store.registerRuntime({ name: "Auto only", provider: "cursor", workspaceId: "local", executionGroupId: "cursor-group",
      models: [model("default")],
    });
    const catalog = executionGroupModelCatalog(store, "local", "cursor-group", "local")[0]!;
    expect(catalog.models.map(entry => entry.id)).toEqual(["default"]);
    expect(catalog.default_thinking).toEqual({ status: "unknown", supported_levels: [] });
    expect((await create({ execution_group_id: "cursor-group", model: "" })).status).toBe(400);
    const failed = store.registerRuntime({ name: "Failed", provider: "cursor", workspaceId: "local", models: [
      { ...model("grok-4.7"), catalog: { status: "error", error: "Model discovery failed" } },
    ] });
    expect((await create({ execution_group_id: failed.executionGroupIds![0], model: "" })).status).toBe(400);
  });

  it("freezes the claimed model and effort while new tasks inherit a changed gateway", () => {
    const { store, runtime, setDefault } = fixture();
    const agent = store.createAgent({ name: "Inherited", provider: "cursor", model: "", thinkingLevel: "low", fallbackModel: "default" });
    const task = store.createTask({ agentId: agent.id, prompt: "First turn" });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(task.id);
    expect(claimed).toMatchObject({ executionModel: "grok-4.7", executionThinkingLevel: "low", fallbackSwitched: false });
    expect(daemonTaskClaimResponse(store, claimed).agent).toMatchObject({ model: "grok-4.7", thinking_level: "low", fallback_model: "default" });
    expect(store.getAgent(agent.id)?.model).toBe("");
    expect(store.requeueTaskOffer(task.id, runtime.id)).toBe(true);
    setDefault("other");
    const reclaimed = store.claimTask(runtime.id)!;
    expect(reclaimed.id).toBe(task.id);
    expect(reclaimed).toMatchObject({ executionModel: "grok-4.7", executionThinkingLevel: "low" });
    expect(daemonTaskClaimResponse(store, reclaimed).agent).toMatchObject({ model: "grok-4.7", thinking_level: "low" });
    store.startTask(task.id);
    store.completeTask(task.id, { output: "Done" });
    const next = store.createTask({ agentId: agent.id, prompt: "Next turn" });
    const nextClaim = store.claimTask(runtime.id)!;
    expect(nextClaim.id).toBe(next.id);
    expect(nextClaim).toMatchObject({ executionModel: "other", executionThinkingLevel: "low" });
  });

  it("keeps a frozen empty effort when the Agent later carries an explicit effort", () => {
    const { store, runtime } = fixture();
    const agent = store.createAgent({ name: "Native effort", provider: "cursor", model: "grok-4.7" });
    store.createTask({ agentId: agent.id, prompt: "Use the native effort selection" });
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed).toMatchObject({ executionModel: "grok-4.7", executionThinkingLevel: null });
    const editedAgent = { ...claimed.agent!, thinkingLevel: "low" };
    expect(agentAtTaskTarget(editedAgent, claimed).thinkingLevel).toBeNull();
    expect(daemonTaskClaimResponse(store, { ...claimed, agent: editedAgent }).agent).toMatchObject({ model: "grok-4.7", thinking_level: "" });
  });
});
