/**
 * MUL-338 — Claude-side regression from #220.
 *
 * Before #220 a provider-wide consensus filled Claude's level-less gateway
 * aliases in. Removing it was correct (the levels were borrowed, not declared)
 * but left nothing to distinguish "this model has no reasoning levels" from
 * "this Runtime cannot execute the model". `runtimeSupportsAgentModel` read the
 * empty level array as a capability the model was missing, so every Runtime
 * rejected the task and it sat in `queued` forever.
 *
 * The gateway Claude catalog is real here: `/v1/models` returns ids and display
 * names and NO reasoning fields, and the Claude ACP bridge reports the native
 * selector only for its own aliases. The four combinations below are the ones
 * reported on the live fleet.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const NATIVE_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const headers = { "Content-Type": "application/json" };

const reasoning = (values: string[], defaultLevel?: string): MultiremiRuntimeModelThinking => ({
  status: values.length ? "supported" : "unsupported",
  supportedLevels: values.map(value => ({ value, label: value })),
  ...(defaultLevel ? { defaultLevel } : {}),
});

/** The real gateway inventory: ids and labels only, no reasoning metadata. */
const GATEWAY_MODELS = [
  "deepseek-v4-flash", "deepseek-flash", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5",
  "gpt-5.6-luna", "kimi-k2", "glm-5", "qwen3-max", "minimax-m2",
  "claude-haiku-4-5", "gemini-3-pro", "grok-5", "llama-4-maverick", "mistral-large-3",
];

/** What the Claude ACP bridge actually reports: native selector ids only. */
const ACP_SELECTOR_MODELS = ["claude-fable-5-1", "sonnet", "sonnet[1m]", "opus[1m]", "haiku"];

function claudeRuntimeModels() {
  return ACP_SELECTOR_MODELS.map((id, index) => ({
    id,
    label: id,
    provider: "anthropic",
    default: index === 0,
    thinking: reasoning(NATIVE_LEVELS, "medium"),
  }));
}

function setup() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
    tokenOp: "set",
    authToken: "test-key",
  });
  store.saveGatewayModels("local", "claude", {
    sourceRevision: revision,
    models: GATEWAY_MODELS.map(id => ({ id, label: id })),
  });
  const runtimes = [0, 1, 2].map(index => store.registerRuntime({
    name: `claude-${index}`, provider: "claude", workspaceId: "local",
    models: claudeRuntimeModels(),
  }));
  return { store, revision, runtimes, app: createMultiremiApp({ store }) };
}

function agentWith(store: ReturnType<typeof createLocalStore>, model: string, thinkingLevel: string) {
  return store.createAgent({ name: `agent-${model}-${thinkingLevel}`, provider: "claude", model, thinkingLevel });
}

describe("MUL-338 Claude gateway models without reasoning metadata", () => {
  // The live-fleet judgement table, reproduced offline.
  const cases: Array<{ model: string; thinkingLevel: string; routable: boolean }> = [
    { model: "deepseek-v4-flash", thinkingLevel: "high", routable: true },
    { model: "deepseek-flash", thinkingLevel: "", routable: true },
    { model: "deepseek-flash", thinkingLevel: "high", routable: true },
    { model: "claude-fable-5-1", thinkingLevel: "high", routable: true },
  ];

  for (const { model, thinkingLevel, routable } of cases) {
    it(`routes ${model} thinking=${thinkingLevel || "(none)"} on every online Claude Runtime`, () => {
      const { store, runtimes } = setup();
      const agent = agentWith(store, model, thinkingLevel);
      // A stale row saved before this fix's write-side convergence existed.
      if (thinkingLevel) expect(store.getAgent(agent.id)?.thinkingLevel).toBe(thinkingLevel);
      const supporting = runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agent));
      expect(supporting.length).toBe(routable ? 3 : 0);
      const task = store.createTask({ agentId: agent.id, prompt: "run" });
      expect(store.claimTask(runtimes[0].id)?.id).toBe(routable ? task.id : undefined);
    });
  }

  it("does not fabricate levels for a gateway-only model", async () => {
    const { store, app } = setup();
    const { providers } = await (await app.request("/api/models")).json();
    const claude = providers.find((provider: { provider: string }) => provider.provider === "claude");
    const deepseek = claude.models.find((model: { id: string }) => model.id === "deepseek-flash");
    // Borrowing the native selector's levels is exactly what must not happen.
    expect(deepseek.thinking).toBeUndefined();
    const fable = claude.models.find((model: { id: string }) => model.id === "claude-fable-5-1");
    expect(fable.thinking.supported_levels.map((level: { value: string }) => level.value)).toEqual(NATIVE_LEVELS);
  });

  it("still blocks a level the model DOES declare but does not offer", () => {
    const { store } = setup();
    const agent = agentWith(store, "claude-fable-5-1", "ultra");
    for (const runtime of store.listRuntimes()) {
      expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(false);
    }
  });

  it("reports a capability wait only for a level the model really lacks", () => {
    const { store } = setup();
    const mismatch = store.createTask({ agentId: agentWith(store, "claude-fable-5-1", "ultra").id, prompt: "run" });
    const gatewayOnly = store.createTask({ agentId: agentWith(store, "deepseek-flash", "high").id, prompt: "run" });
    const now = Date.now() + 5 * 60_000;
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    expect(store.getTask(mismatch.id)?.waitReason).toContain("等待模型能力恢复");
    // The whole point of the fix: no permanent capability wait for this one.
    expect(store.getTask(gatewayOnly.id)?.waitReason ?? null).toBeNull();
  });

  it("converges a stored level away on the next Agent write", async () => {
    const { store, app } = setup();
    const agent = agentWith(store, "deepseek-v4-flash", "high");
    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ description: "metadata-only edit" }),
    });
    expect(response.status).toBe(200);
    // Unrelated edits used to preserve the unusable selection forever.
    expect(store.getAgent(agent.id)?.thinkingLevel ?? "").toBe("");
  });

  it("still rejects an effort the caller explicitly asks for and the catalog cannot confirm", async () => {
    const { store, app } = setup();
    const agent = agentWith(store, "deepseek-flash", "");
    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-flash", thinking_level: "high" }),
    });
    // A fresh choice is judged, not silently rewritten: the caller is told the
    // effort was not honoured instead of getting a 200 for something else.
    expect(response.status).toBe(400);
    expect(store.getAgent(agent.id)?.thinkingLevel ?? "").toBe("");
    // The Agent stays schedulable either way — the level never gated routing.
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(store.listRuntimes()[0].id)?.id).toBe(task.id);
  });

  it("heals the stale level even when the edit resends the saved selection verbatim", async () => {
    const { store, app } = setup();
    const agent = agentWith(store, "deepseek-v4-flash", "high");
    // A client that PUTs the whole Agent back (model + effort unchanged) is the
    // case that used to short-circuit validation and keep the level forever.
    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash", thinking_level: "high" }),
    });
    expect(response.status).toBe(200);
    expect(store.getAgent(agent.id)?.thinkingLevel ?? "").toBe("");
  });

  it("clears the carried-over level when the model changes to a level-less one", async () => {
    const { store, app } = setup();
    const agent = agentWith(store, "claude-fable-5-1", "high");
    // Switching model without naming an effort must not fail on the effort that
    // was left over from the previous model — the user never chose it here.
    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    });
    expect(response.status).toBe(200);
    expect(store.getAgent(agent.id)).toMatchObject({ model: "deepseek-v4-flash", thinkingLevel: "" });
  });
});

describe("MUL-338 does not weaken the Codex catalog contract (#220)", () => {
  it("still blocks a Codex level the engine's catalog does not declare", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({
      name: "codex-vendor", provider: "codex", workspaceId: "local",
      // The catalog declares this model but no reasoning levels for it: unlike
      // the Claude aliases, that is the engine stating the effort is unavailable.
      models: [{ id: "gpt-model", label: "GPT", provider: "openai", default: true }],
    });
    const agent = store.createAgent({ name: "codex reasoner", provider: "codex", model: "gpt-model", thinkingLevel: "high" });
    expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(false);
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("does not converge a Codex level the caller echoed back with the selection", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const runtime = store.registerRuntime({
      name: "codex-vendor", provider: "codex", workspaceId: "local",
      models: [{ id: "gpt-levelless", label: "GPT", provider: "openai", default: true }],
    });
    const agent = store.createAgent({ name: "codex echo", provider: "codex", model: "gpt-levelless", thinkingLevel: "high" });
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ model: "gpt-levelless", thinking_level: "high" }),
    });
    expect(response.status).toBe(200);
    // Routing still refuses this pair, so clearing it here would smuggle a
    // rejected selection into a runnable one at the default effort.
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("high");
    expect(store.runtimeSupportsAgentModel(store.getRuntime(runtime.id)!, store.getAgent(agent.id)!)).toBe(false);
  });

  it("leaves other ACP engines (antigravity) on the strict contract", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({
      name: "antigravity", provider: "antigravity", workspaceId: "local",
      models: [{ id: "ag-model", label: "AG", provider: "antigravity", default: true }],
    });
    const agent = store.createAgent({ name: "ag agent", provider: "antigravity", model: "ag-model", thinkingLevel: "high" });
    // Same ACP thought_level channel as Codex: an empty list is the engine
    // saying it cannot honour the effort, not missing information.
    expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(false);
  });

  it("keeps a Runtime out while its capability load is failing", () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "codex", {
      fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
      tokenOp: "set", authToken: "test-key",
    });
    store.saveGatewayModels("local", "codex", {
      sourceRevision: revision, nativeCatalogStatus: "ready",
      models: [{ id: "gpt-5", label: "GPT-5", thinking: reasoning(["low", "high", "max"], "high") }],
    });
    const runtime = store.registerRuntime({
      name: "codex", provider: "codex", workspaceId: "local", models: [
        { id: "gpt-5", label: "GPT-5", provider: "openai", default: true, thinking: reasoning(["low", "high", "max"], "high") },
      ],
    });
    const agent = store.createAgent({ name: "codex agent", provider: "codex", model: "gpt-5", thinkingLevel: "max" });
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);

    // A load failure is not "no levels"; the Runtime genuinely cannot honour the model.
    store.updateRuntimeModels(runtime.id, [{ id: "gpt-5", label: "GPT-5", provider: "openai", default: true,
      thinking: { status: "error", supportedLevels: [], error: "catalog HTTP 503" },
    }]);
    const blocked = store.createTask({ agentId: agent.id, prompt: "run again" });
    expect(store.runtimeSupportsAgentModel(store.getRuntime(runtime.id)!, agent)).toBe(false);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(blocked.id)?.status).toBe("queued");
  });

  it("keeps blocking a Codex model that is absent from an authoritative catalog", () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "codex", {
      fragment: 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"',
      tokenOp: "set", authToken: "test-key",
    });
    store.saveGatewayModels("local", "codex", {
      sourceRevision: revision, nativeCatalogStatus: "ready",
      models: [{ id: "gpt-5", label: "GPT-5", thinking: reasoning(["low", "high"], "low") }],
    });
    const runtime = store.registerRuntime({
      name: "codex", provider: "codex", workspaceId: "local", models: [
        { id: "gpt-5", label: "GPT-5", provider: "openai", default: true, thinking: reasoning(["low", "high"], "low") },
      ],
    });
    const agent = store.createAgent({ name: "codex agent", provider: "codex", model: "not-in-catalog", thinkingLevel: "low" });
    expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(false);
  });
});
