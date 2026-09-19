import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { agentCompatibilityResponse, daemonClaimAgentResponse } from "@multiremi/api/wire/agents.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = { "Content-Type": "application/json" };
const thinking = (level: string) => ({ status: "supported" as const,
  supportedLevels: [{ value: level, label: level }], defaultLevel: level });

function setup() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Codex", provider: "codex", executionGroupId: "fallback-group",
    models: [
      { id: "primary", label: "Primary", provider: "openai", default: true, thinking: thinking("high"), catalog: { status: "ready" } },
      { id: "backup", label: "Backup", provider: "openai", default: false, thinking: thinking("low"), catalog: { status: "ready" } },
    ],
  });
  const other = store.registerRuntime({ name: "Other", provider: "codex", models: [
    { id: "other", label: "Other", provider: "openai", default: true, catalog: { status: "ready" } },
  ] });
  const app = createMultiremiApp({ store });
  const request = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) =>
    app.request(path, { method, headers, body: JSON.stringify(body) });
  return { store, runtime, other, request, app };
}

describe("Agent fallback configuration", () => {
  it("writes, reads, preserves and explicitly clears both fields", async () => {
    const { store, runtime, request, app } = setup();
    const created = await request("/api/agents", "POST", { name: "Backup agent", provider: "codex", runtime_id: runtime.id,
      model: "primary", fallback_model: "backup", fallback_thinking_level: "low" });
    expect(created.status, await created.clone().text()).toBe(201);
    const agent = store.getAgent((await created.json()).id)!;
    expect(agent).toMatchObject({ fallbackModel: "backup", fallback_model: "backup", fallbackThinkingLevel: "low", fallback_thinking_level: "low" });
    expect(await (await app.request(`/api/agents/${agent.id}`)).json()).toMatchObject({ fallback_model: "backup", fallback_thinking_level: "low" });
    expect(agentCompatibilityResponse(store, agent)).toMatchObject({ fallback_model: "backup", fallback_thinking_level: "low" });
    expect(daemonClaimAgentResponse(agent)).toMatchObject({ fallback_model: "backup", fallback_thinking_level: "low" });
    const edited = await request(`/api/agents/${agent.id}`, "PUT", { description: "Only metadata" });
    expect(edited.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ fallbackModel: "backup", fallbackThinkingLevel: "low" });
    const cleared = await request(`/api/agents/${agent.id}`, "PUT", { fallback_model: "" });
    expect(cleared.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ fallbackModel: null, fallbackThinkingLevel: null });
    expect(await (await app.request(`/api/agents/${agent.id}`)).json()).toMatchObject({ fallback_model: "", fallback_thinking_level: "" });
  });

  it("clears both saved fallback fields on execution target changes", async () => {
    const { store, runtime, other, request } = setup();
    const agent = store.createAgent({ name: "Switch target", provider: "codex", runtimeId: runtime.id,
      model: "primary", fallbackModel: "backup", fallbackThinkingLevel: "low" });
    const response = await request(`/api/agents/${agent.id}`, "PUT", { runtime_id: other.id });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ model: "", fallbackModel: null, fallbackThinkingLevel: null });
  });

  for (const target of ["runtime", "group", "workspace"] as const) {
    it(`rejects identical, unavailable and unsupported fallback selections for ${target}`, async () => {
      const { runtime, request } = setup();
      const binding = target === "runtime" ? { runtime_id: runtime.id }
        : target === "group" ? { execution_group_id: "fallback-group" } : {};
      const base = { provider: "codex", model: "primary", ...binding };
      const same = await request("/api/agents", "POST", { name: "Same", ...base, fallback_model: "primary" });
      expect(same.status).toBe(400);
      expect((await same.json()).error).toContain("different");
      const unavailable = await request("/api/agents", "POST", { name: "Absent", ...base, fallback_model: "absent" });
      expect(unavailable.status).toBe(400);
      expect((await unavailable.json()).code).toBe("model_not_in_execution_catalog");
      const unsupported = await request("/api/agents", "POST", { name: "Effort", ...base,
        fallback_model: "backup", fallback_thinking_level: "high" });
      expect(unsupported.status).toBe(400);
      expect((await unsupported.json()).error).toContain("fallback_thinking_level");
    });
  }

  it("compares the backup with the effective default and the template's recommended model", async () => {
    const { runtime, request } = setup();
    const implicit = await request("/api/agents", "POST", {
      name: "Implicit primary", provider: "codex", runtime_id: runtime.id, fallback_model: "primary",
    });
    expect(implicit.status).toBe(400);
    expect((await implicit.json()).error).toContain("different");
    const template = await request("/api/agents/from-template", "POST", {
      template_slug: "atlas-llm-wiki", name: "Template primary", fallback_model: "deepseek-v4-flash",
    });
    expect(template.status).toBe(400);
    expect((await template.json()).error).toContain("different");
  });

  it("allows metadata edits with saved fallback when the model catalog is no longer available", async () => {
    const { store, runtime, request } = setup();
    const agent = store.createAgent({ name: "Saved", provider: "codex", runtimeId: runtime.id,
      model: "primary", fallbackModel: "backup", fallbackThinkingLevel: "low" });
    store.updateRuntimeModels(runtime.id, [{ id: "primary", label: "Primary", provider: "openai", default: true, catalog: { status: "ready" } }]);
    const response = await request(`/api/agents/${agent.id}`, "PUT", { name: "Renamed", fallback_model: "backup" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ name: "Renamed", fallbackModel: "backup" });
  });
});
