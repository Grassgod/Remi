import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({
    id: "target-a", name: "Machine A", provider: "codex", ownerId: "local",
    metadata: { codex_profiles: 1 },
    models: [{ id: "model-a", label: "A", provider: "openai", default: true, thinking: { supportedLevels: [{ value: "high", label: "High" }] } }],
  });
  const peer = store.registerRuntime({
    id: "target-b", name: "Machine B", provider: "codex", ownerId: "local",
    metadata: { codex_profiles: 1 },
    models: [{ id: "model-b", label: "B", provider: "openai", default: true, thinking: { supportedLevels: [{ value: "low", label: "Low" }] } }],
  });
  const app = createMultiremiApp({ store });
  const request = (path: string, body: unknown, method = "POST") => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { store, runtime, peer, app, request };
}

describe("agent machine/type execution targets", () => {
  for (const path of ["/api/agents", "/api/multiremi/agents", "/api/agents/from-template", "/api/multiremi/agents/from-template", "/api/multiremi/agents/default"]) {
    it(`preserves target on creation through ${path}`, async () => {
      const { store, runtime, request } = setup();
      const response = await request(path, { name: "Targeted", runtime_id: runtime.id, template_slug: "summarizer" });
      expect(response.status).toBe(201);
      const body = await response.json();
      const agent = store.getAgent((body.agent ?? body).id)!;
      expect(agent.runtimeId).toBe(runtime.id);
      expect(agent.provider).toBe("codex");
    });
  }

  it("returns only the chosen machine catalog and keeps it available while offline", async () => {
    const { store, runtime, app } = setup();
    store.setRuntimeOffline(runtime.id);
    const response = await app.request(`/api/models?runtime_id=${runtime.id}`);
    expect(response.status).toBe(200);
    const { providers } = await response.json();
    expect(providers).toHaveLength(1);
    expect(providers[0].online_runtime_count).toBe(0);
    expect(providers[0].models.map((model: { id: string }) => model.id)).toEqual(["model-a"]);
  });

  it("validates thinking against the target rather than another machine", async () => {
    const { runtime, request } = setup();
    const bad = await request("/api/agents", { name: "Bad", runtime_id: runtime.id, model: "model-b", thinking_level: "low" });
    expect(bad.status).toBe(400);
    const good = await request("/api/agents", { name: "Good", runtime_id: runtime.id, model: "model-a", thinking_level: "high" });
    expect(good.status).toBe(201);
  });

  it("resets model and thinking when switching machines and preserves the new binding on later edits", async () => {
    const { store, runtime, peer, request } = setup();
    const agent = store.createAgent({ name: "Move", runtimeId: runtime.id, provider: "codex", model: "model-a", thinkingLevel: "high" });
    const changed = await request(`/api/agents/${agent.id}`, { runtime_id: peer.id }, "PUT");
    expect(changed.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ runtimeId: peer.id, model: "", thinkingLevel: "" });
    const renamed = await request(`/api/agents/${agent.id}`, { name: "Renamed" }, "PUT");
    expect(renamed.status).toBe(200);
    expect(store.getAgent(agent.id)?.runtimeId).toBe(peer.id);
  });

  it("uses a fixed connection model and rejects contradictory model and provider selections", async () => {
    const { store, runtime, app, request } = setup();
    store.setRuntimeCodexProfile(runtime.id, { name: "Custom", base_url: "https://custom.example/v1", model: "fixed", env_key: "REMI_CODEX_CUSTOM" });
    const catalog = await app.request(`/api/models?runtime_id=${runtime.id}`);
    expect((await catalog.json()).providers[0].models.map((model: { id: string }) => model.id)).toEqual(["fixed"]);
    for (const path of ["/api/agents", "/api/agents/from-template"]) {
      const bad = await request(path, { name: "Wrong", runtime_id: runtime.id, model: "model-b", template_slug: "summarizer" });
      expect(bad.status).toBe(400);
    }
    const unsupportedThinking = await request("/api/agents", { name: "Unknown thinking", runtime_id: runtime.id, model: "fixed", thinking_level: "high" });
    expect(unsupportedThinking.status).toBe(400);
    const wrongEngine = await request("/api/agents", { name: "Wrong engine", runtime_id: runtime.id, provider: "claude" });
    expect(wrongEngine.status).toBe(400);
  });

  it("rejects unknown targets while retaining the manual model escape hatch without a profile", async () => {
    const { runtime, app, request } = setup();
    expect((await app.request("/api/models?runtime_id=missing")).status).toBe(400);
    expect((await request("/api/agents", { name: "Missing", runtime_id: "missing" })).status).toBe(400);
    expect((await request("/api/agents", { name: "Gateway", runtime_id: runtime.id, model: "not-yet-discovered" })).status).toBe(201);
  });
  it("updates the existing default target and rejects an invalid target before creating a default", async () => {
    const { store, runtime, peer, request } = setup();
    expect((await request("/api/multiremi/agents/default", { runtime_id: "missing" })).status).toBe(400);
    expect(store.listAgents()).toHaveLength(0);
    const first = await request("/api/multiremi/agents/default", { runtime_id: runtime.id });
    const { agent } = await first.json();
    store.updateAgent(agent.id, { model: "model-a", thinkingLevel: "high" });
    const second = await request("/api/multiremi/agents/default", { runtime_id: peer.id });
    expect(second.status).toBe(200);
    expect((await second.json()).agent).toMatchObject({ id: agent.id, runtimeId: peer.id, model: "", thinkingLevel: "" });
  });

  it("overlays the workspace gateway only on unprofiled targets without leaking another machine's custom model", async () => {
    const { store, runtime, peer, app } = setup();
    store.setRuntimeCodexProfile(peer.id, { name: "other-connection", base_url: "https://custom.example/v1", model: "private-model", env_key: "REMI_CODEX_OTHER" });
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "codex", {
      fragment: JSON.stringify({ env: { OPENAI_BASE_URL: "https://gateway.example" } }), tokenOp: "set", authToken: "test-token",
    });
    store.saveGatewayModels("local", "codex", { sourceRevision: revision, models: [{ id: "gateway-model", label: "Gateway" }] });
    const target = await app.request(`/api/models?runtime_id=${runtime.id}`);
    expect((await target.json()).providers[0].models.map((model: { id: string }) => model.id)).toEqual(["gateway-model"]);
    const custom = await app.request(`/api/models?runtime_id=${peer.id}`);
    expect((await custom.json()).providers[0].models.map((model: { id: string }) => model.id)).toEqual(["private-model"]);
  });

  it("rejects an admin assigning another owner's agent to an incompatible private target", async () => {
    const { store, runtime, request } = setup();
    const agent = store.createAgent({ name: "Another owner", provider: "codex", ownerId: "other" });
    const response = await request(`/api/agents/${agent.id}`, { runtime_id: runtime.id }, "PUT");
    expect(response.status).toBe(403);
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
  });

  it("allows a normal edit with the unchanged provider after a bound public target becomes private", async () => {
    const { store, runtime, request } = setup();
    store.updateRuntime(runtime.id, { visibility: "public" });
    const agent = store.createAgent({ name: "Existing", provider: "codex", runtimeId: runtime.id, ownerId: "other" });
    store.updateRuntime(runtime.id, { visibility: "private" });
    const renamed = await request(`/api/agents/${agent.id}`, { name: "Renamed", provider: "codex" }, "PUT");
    expect(renamed.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ name: "Renamed", runtimeId: runtime.id });
  });

  it("rejects a resubmitted unchanged model after its target connection model changes", async () => {
    const { store, runtime, request } = setup();
    const profile = { name: "custom", base_url: "https://custom.example/v1", model: "first-model", env_key: "REMI_CODEX_CUSTOM" };
    store.setRuntimeCodexProfile(runtime.id, profile);
    const agent = store.createAgent({ name: "Existing", provider: "codex", runtimeId: runtime.id, model: "first-model" });
    store.setRuntimeCodexProfile(runtime.id, { ...profile, model: "second-model" });
    const response = await request(`/api/agents/${agent.id}`, { name: "Renamed", model: " first-model " }, "PUT");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'model "first-model" is not supported by the selected Runtime connection; expected "second-model"' });
    expect(store.getAgent(agent.id)?.name).toBe("Existing");
  });

});
