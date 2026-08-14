// The fleet catalog the UI reads: which engines/models an any-provider runtime
// surfaces, how models bucket by runtime engine, and cross-connection claim atomicity.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — fleet engine and model catalog", () => {
  it("rejects unknown providers smuggled through an any-provider runtime", async () => {
    const store = createStore();
    const anyRuntime = store.registerRuntime({ id: "rt_any_gate", name: "any gate", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const smuggled = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gemini smuggle", runtime_id: anyRuntime.id, provider: "gemini" }),
    });
    expect(smuggled.status).toBe(400);
    expect(await smuggled.json()).toEqual({ error: 'unknown provider "gemini"' });

    // Omitting the provider falls back to the default engine.
    const defaulted = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Any default", runtime_id: anyRuntime.id }),
    });
    expect(defaulted.status).toBe(201);
    expect(store.getAgent((await defaulted.json()).id)?.provider).toBe("claude");
  });

  it("surfaces engines through an any-provider runtime in the fleet catalog", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_fleet_any_only", name: "fleet any only", provider: "any", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    const body = await response.json();
    const providers = new Map(body.providers.map((entry: any) => [entry.provider, entry]));
    expect((providers.get("claude") as any)?.online_runtime_count).toBe(1);
    expect((providers.get("codex") as any)?.online_runtime_count).toBe(1);
  });

  it("maps an any-runtime's vendor models onto the right engine buckets", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_any_models",
      name: "any with models",
      provider: "any",
      workspaceId: "local",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", default: true },
      ],
    });
    const app = createMultiremiApp({ store });
    const body = await (await app.request("/api/models")).json();
    const codex = body.providers.find((e: any) => e.provider === "codex");
    const claude = body.providers.find((e: any) => e.provider === "claude");
    expect(codex.models.map((m: any) => m.id)).toEqual(["gpt-5.5"]);
    expect(claude.models.map((m: any) => m.id)).toEqual(["claude-sonnet-4-6"]);
    // No vendor buckets leak into the response.
    expect(body.providers.find((e: any) => e.provider === "openai")).toBeUndefined();
    expect(body.providers.find((e: any) => e.provider === "anthropic")).toBeUndefined();
  });

  it("buckets fleet models by the runtime engine, not the model vendor", async () => {
    const store = createStore();
    // Production shape: codex runtime reports models with vendor provider "openai".
    store.registerRuntime({
      id: "rt_engine_bucket",
      name: "codex box",
      provider: "codex",
      workspaceId: "local",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
        { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: false },
      ],
    });
    const app = createMultiremiApp({ store });
    const body = await (await app.request("/api/models")).json();
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    // Models land in the codex (engine) bucket, not an "openai" bucket.
    expect(codex.online_runtime_count).toBe(1);
    expect(codex.models.map((m: any) => m.id).sort()).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(body.providers.find((entry: any) => entry.provider === "openai")).toBeUndefined();
  });

  it("counts only the caller's usable runtimes in the fleet catalog", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    // Alice's private codex runtime + Bob's private codex runtime + a public one.
    store.registerRuntime({ id: "rt_cap_alice", name: "alice codex", provider: "codex", workspaceId: "local", ownerId: "alice", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_bob", name: "bob codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "private" });
    store.registerRuntime({ id: "rt_cap_pub", name: "shared codex", provider: "codex", workspaceId: "local", ownerId: "bob", visibility: "public" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/models", { headers: { Authorization: `Bearer ${aliceToken.token}` } });
    const body = await response.json();
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    // Alice sees her own private + the public one, NOT bob's private one.
    expect(codex.online_runtime_count).toBe(2);
  });

  it("serves the fleet model catalog grouped by provider", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_fleet_claude_a",
      name: "fleet claude a",
      provider: "claude",
      workspaceId: "local",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", provider: "claude", default: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false },
      ],
    });
    store.registerRuntime({
      id: "rt_fleet_claude_b",
      name: "fleet claude b",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", default: false }],
    });
    const offline = store.registerRuntime({
      id: "rt_fleet_codex",
      name: "fleet codex",
      provider: "codex",
      workspaceId: "local",
      models: [{ id: "gpt-5.2", label: "GPT-5.2", provider: "codex", default: true }],
    });
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", offline.id]);

    const app = createMultiremiApp({ store });
    const response = await app.request("/api/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    const claude = body.providers.find((entry: any) => entry.provider === "claude");
    expect(claude.online_runtime_count).toBe(2);
    expect(claude.models.map((model: any) => model.id).sort()).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(claude.models.find((model: any) => model.id === "claude-opus-4-8").default).toBe(true);
    // Offline runtimes still surface their provider (capacity 0) but not a catalog.
    const codex = body.providers.find((entry: any) => entry.provider === "codex");
    expect(codex.online_runtime_count).toBe(0);
    expect(codex.models).toEqual([]);
  });

  it("keeps gateway visibility while preserving matching runtime effort metadata", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.registerRuntime({
      id: "rt_gateway_effort_a",
      name: "gateway effort a",
      provider: "claude",
      workspaceId: "local",
      models: [
        {
          id: "claude-fable-5",
          label: "Runtime label",
          provider: "anthropic",
          default: true,
          thinking: {
            supportedLevels: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
            defaultLevel: "high",
          },
        },
        { id: "runtime-only", label: "Runtime only", provider: "anthropic", default: false },
      ],
    });
    store.registerRuntime({
      id: "rt_gateway_effort_b",
      name: "gateway effort b",
      provider: "claude",
      workspaceId: "local",
      models: [{
        id: "claude-fable-5",
        label: "Other runtime label",
        provider: "anthropic",
        default: false,
        thinking: {
          supportedLevels: [
            { value: "xhigh", label: "Extra high" },
            { value: "max", label: "Max" },
          ],
        },
      }],
    });
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
      tokenOp: "set",
      authToken: "test-token",
    });
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision,
      models: [
        { id: "claude-fable-5", label: "Gateway Fable 5" },
        { id: "gateway-only", label: "Gateway only" },
      ],
    });

    const app = createMultiremiApp({ store });
    const body = await (await app.request("/api/models")).json();
    const claude = body.providers.find((entry: any) => entry.provider === "claude");
    expect(claude.models.map((model: any) => model.id)).toEqual(["claude-fable-5", "gateway-only"]);
    const fable = claude.models[0];
    expect(fable.label).toBe("Gateway Fable 5");
    expect(fable.default).toBe(true);
    expect(fable.thinking.default_level).toBe("high");
    // Fleet selection semantics are unchanged: the first/default runtime model
    // wins; the gateway overlay only preserves that selected model's metadata.
    expect(fable.thinking.supported_levels.map((level: any) => level.value).sort()).toEqual(["high", "low"]);
    expect(claude.models[1].thinking).toBeUndefined();
  });

  it("validates an agent's model and effort together against its workspace catalog", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_agent_catalog",
      name: "agent catalog",
      provider: "claude",
      workspaceId: "local",
      models: [
        {
          id: "claude-fable-5",
          label: "Fable 5",
          provider: "anthropic",
          default: true,
          thinking: {
            supportedLevels: [
              { value: "low", label: "Low" },
              { value: "max", label: "Max" },
            ],
          },
        },
        {
          id: "claude-fast",
          label: "Fast",
          provider: "anthropic",
          default: false,
          thinking: { supportedLevels: [{ value: "low", label: "Low" }] },
        },
      ],
    });
    const app = createMultiremiApp({ store });
    const headers = { "Content-Type": "application/json" };

    const customModel = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Custom model", provider: "claude", model: "claude-missing" }),
    });
    expect(customModel.status).toBe(201);
    expect((await customModel.json()).model).toBe("claude-missing");

    const unverifiedCustomEffort = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Unknown model effort",
        provider: "claude",
        model: "claude-missing",
        thinking_level: "max",
      }),
    });
    expect(unverifiedCustomEffort.status).toBe(400);
    expect((await unverifiedCustomEffort.json()).error).toContain(
      'model "claude-missing" is not available',
    );

    const invalidEffort = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bad effort", provider: "claude", model: "claude-fast", thinking_level: "max" }),
    });
    expect(invalidEffort.status).toBe(400);
    expect((await invalidEffort.json()).error).toBe(
      'thinking_level "max" is not supported by model "claude-fast" for provider "claude"',
    );

    // An empty model means provider default; effort is checked against the
    // catalog's default model before either field is persisted.
    const valid = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Default Fable", provider: "claude", thinking_level: "max" }),
    });
    expect(valid.status).toBe(201);
    const agent = await valid.json();
    expect(agent.model).toBe("");
    expect(agent.thinking_level).toBe("max");

    const rejectedAtomicUpdate = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "claude-fast" }),
    });
    expect(rejectedAtomicUpdate.status).toBe(400);
    expect(store.getAgent(agent.id)?.model).toBeNull();
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("max");

    const validAtomicUpdate = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "claude-fast", thinking_level: "low" }),
    });
    expect(validAtomicUpdate.status).toBe(200);
    expect(store.getAgent(agent.id)?.model).toBe("claude-fast");
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("low");

    // The edit dialog submits the complete selection even when only metadata
    // changed. A temporarily unavailable catalog must not block that no-op
    // selection from saving the new name/description.
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", [
      "2020-01-01T00:00:00.000Z",
      runtime.id,
    ]);
    const metadataOnlyUpdate = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Renamed while catalog is unavailable",
        description: "Metadata still saves",
        provider: " claude ",
        model: " claude-fast ",
        thinking_level: " low ",
      }),
    });
    expect(metadataOnlyUpdate.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({
      name: "Renamed while catalog is unavailable",
      description: "Metadata still saves",
      provider: "claude",
      model: "claude-fast",
      thinkingLevel: "low",
    });

    const changedEffortWithoutCatalog = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        provider: "claude",
        model: "claude-fast",
        thinking_level: "max",
      }),
    });
    expect(changedEffortWithoutCatalog.status).toBe(400);
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("low");
  });

  it("allows custom models but rejects unverifiable effort when no catalog is available", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const headers = { "Content-Type": "application/json" };

    const providerDefaults = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Provider defaults", provider: "claude", model: "", thinking_level: "" }),
    });
    expect(providerDefaults.status).toBe(201);

    const explicitModel = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "No catalog model", provider: "claude", model: "claude-fable-5" }),
    });
    expect(explicitModel.status).toBe(201);
    expect((await explicitModel.json()).model).toBe("claude-fable-5");

    const explicitEffort = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "No catalog effort", provider: "claude", thinking_level: "max" }),
    });
    expect(explicitEffort.status).toBe(400);
    expect((await explicitEffort.json()).error).toContain("no model catalog is available");
  });

  it("accepts runtime-advertised effort values without a provider-wide allowlist", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_dynamic_effort",
      name: "dynamic effort",
      provider: "codex",
      workspaceId: "local",
      models: [{
        id: "gpt-dynamic",
        label: "GPT Dynamic",
        provider: "openai",
        default: true,
        thinking: { supportedLevels: [{ value: "ultra", label: "Ultra" }] },
      }],
    });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dynamic effort",
        provider: "codex",
        model: "gpt-dynamic",
        thinking_level: "ultra",
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).thinking_level).toBe("ultra");
  });

  it("requires an explicit model for effort when the catalog has no declared default", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_no_default_model",
      name: "no default model",
      provider: "codex",
      workspaceId: "local",
      models: [{
        id: "gpt-no-default",
        label: "GPT No Default",
        provider: "openai",
        default: false,
        thinking: { supportedLevels: [{ value: "high", label: "High" }] },
      }],
    });
    const app = createMultiremiApp({ store });
    const headers = { "Content-Type": "application/json" };

    const ambiguous = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ambiguous effort", provider: "codex", thinking_level: "high" }),
    });
    expect(ambiguous.status).toBe(400);
    expect((await ambiguous.json()).error).toContain("no default model is identified");

    const explicit = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Explicit effort model",
        provider: "codex",
        model: "gpt-no-default",
        thinking_level: "high",
      }),
    });
    expect(explicit.status).toBe(201);
  });

  it("claims runtime tasks atomically across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-task-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const runtime = storeA.registerRuntime({ id: "rt_atomic_claim", name: "atomic", provider: "codex", maxConcurrency: 1 });
      const agent = storeA.createAgent({ name: "Atomic Codex", provider: "codex" });
      const otherAgent = storeA.createAgent({ name: "Other Atomic Codex", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "claim exactly once" });
      const otherTask = storeA.createTask({ agentId: otherAgent.id, prompt: "wait for runtime capacity" });

      const first = storeA.claimTask(runtime.id);
      const second = storeB.claimTask(runtime.id);
      const claimedIds = [first?.id, second?.id].filter(Boolean);
      expect(claimedIds).toEqual([task.id]);
      expect(storeA.getTask(task.id)?.status).toBe("dispatched");
      expect(storeA.getTask(task.id)?.runtimeId).toBe(runtime.id);
      expect(storeA.getTask(otherTask.id)?.status).toBe("queued");
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
