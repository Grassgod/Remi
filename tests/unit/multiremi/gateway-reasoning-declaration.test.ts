/**
 * MUL-338 item 4 — an administrator's explicit reasoning-level declaration.
 *
 * The Claude gateway inventory carries ids and display names and nothing else
 * (docs/runtime-model-discovery.md), and the ACP bridge reports levels only for
 * its own selector aliases, so a gateway-only alias has no reasoning source
 * behind it at all. Borrowing another model's levels is what #220 removed and
 * must not come back — but that left the model permanently unusable at a chosen
 * effort. The way out is an explicit statement by an administrator: a legitimate
 * source, stored apart from the discovery snapshot (which is rewritten on every
 * probe), and only ever filling a gap rather than overriding a real declaration.
 *
 * The precedence under test, fixed by the Issue:
 *
 *   gateway declaration  >  Runtime report  >  manual declaration  >  family
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { FleetProviderModelsResponse } from "@multiremi/store/runtime-model-catalog.js";
import { catalogAllowsModel } from "@multiremi/store/runtime-model-catalog.js";
import type { MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = { "Content-Type": "application/json" };
const CLAUDE_FRAG = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } });
const CODEX_FRAG = 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"';

const reasoning = (values: string[], defaultLevel?: string): MultiremiRuntimeModelThinking => ({
  status: values.length ? "supported" : "unsupported",
  supportedLevels: values.map(value => ({ value, label: value })),
  ...(defaultLevel ? { defaultLevel } : {}),
});

const NATIVE_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** The real gateway inventory on the live fleet: ids and labels, no metadata. */
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

/** Three online Claude Runtimes and the 15-model gateway snapshot. */
function setupClaude() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "test-key",
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

function setupCodex() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "codex", {
    fragment: CODEX_FRAG, tokenOp: "set", authToken: "test-key",
  });
  store.saveGatewayModels("local", "codex", {
    sourceRevision: revision, nativeCatalogStatus: "ready",
    // The native catalog declared levels for the model it knows about, and said
    // nothing at all about the level-less one.
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", thinking: { status: "supported", supportedLevels: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], defaultLevel: "high" } },
      { id: "gpt-levelless", label: "GPT level-less" },
    ],
  });
  return { store, revision, app: createMultiremiApp({ store }) };
}

function declareLevels(
  store: ReturnType<typeof createLocalStore>,
  engine: "claude" | "codex",
  modelId: string,
  levels: string[],
  defaultLevel?: string,
) {
  return store.saveGatewayModelReasoning("local", engine, { modelId, levels, defaultLevel, updatedBy: "user_local" });
}

async function listing(app: ReturnType<typeof createMultiremiApp>, engine = "claude") {
  const response = await app.request(`/api/workspaces/local/relay-config/${engine}/reasoning-levels`);
  expect(response.status).toBe(200);
  return await response.json() as {
    engine: string;
    allowed_levels: string[];
    models: Array<{
      model_id: string;
      label: string;
      manual: {
        levels: string[]; default_level?: string; updated_by: string | null; updated_at: string;
        state: "effective" | "outranked" | "blocked";
        state_code?: "not_in_execution_catalog" | "execution_catalog_unknown" | "not_in_catalog";
      } | null;
      effective: { supported_levels: Array<{ value: string }>; default_level?: string; status?: string; source: string } | null;
    }>;
  };
}

function row(body: Awaited<ReturnType<typeof listing>>, modelId: string) {
  return body.models.find(model => model.model_id === modelId);
}

function levelsOf(thinking: { supported_levels: Array<{ value: string }> } | null | undefined) {
  return thinking?.supported_levels.map(level => level.value);
}

async function catalogFor(app: ReturnType<typeof createMultiremiApp>, provider: string) {
  const { providers } = await (await app.request("/api/models")).json() as { providers: FleetProviderModelsResponse[] };
  return providers.find(entry => entry.provider === provider);
}

describe("MUL-338 gateway reasoning declarations: storage", () => {
  it("round-trips a declaration with its provenance", () => {
    const { store } = setupClaude();

    const saved = declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");

    expect(saved).toMatchObject({
      modelId: "deepseek-v4-flash",
      levels: ["low", "high", "max"],
      defaultLevel: "high",
      updatedBy: "user_local",
    });
    expect(Number.isFinite(Date.parse(saved!.updatedAt))).toBe(true);
    expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")).toEqual(saved);
    expect(store.listGatewayModelReasoning("local", "claude").map(entry => entry.modelId)).toEqual(["deepseek-v4-flash"]);
  });

  it("stores an empty level set as a deletion, never as an empty declaration", () => {
    const { store } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high"]);

    // An empty set would read as an authoritative "unsupported" anywhere the
    // declaration is consulted, which is the MUL-338 queue hang again.
    expect(store.saveGatewayModelReasoning("local", "claude", { modelId: "deepseek-v4-flash", levels: [] })).toBeNull();
    expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")).toBeNull();
    expect(store.listGatewayModelReasoning("local", "claude")).toEqual([]);
  });

  it("drops a default level the declaration does not contain", () => {
    const { store } = setupClaude();

    const saved = declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high"], "max");

    expect(saved?.levels).toEqual(["low", "high"]);
    expect(saved?.defaultLevel).toBeUndefined();
  });

  it("keeps declarations apart per engine", () => {
    const { store } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high"]);

    expect(store.listGatewayModelReasoning("local", "claude").map(entry => entry.modelId)).toEqual(["deepseek-v4-flash"]);
    expect(store.listGatewayModelReasoning("local", "codex")).toEqual([]);
  });
});

describe("MUL-338 gateway reasoning declarations: the read model", () => {
  it("lists the probe snapshot, with no source for a model nobody declares", async () => {
    const { app } = setupClaude();

    const body = await listing(app);

    expect(body.allowed_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(body.models.map(model => model.model_id)).toEqual([...GATEWAY_MODELS].sort());
    const undeclared = row(body, "deepseek-v4-flash")!;
    expect(undeclared.manual).toBeNull();
    // No gateway metadata, no ACP alias, no family to infer from: the row says
    // "nothing is known", it does not invent a set.
    expect(undeclared.effective).toBeNull();
  });

  it("reports a declaration as the model's effective source", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");

    const declared = row(await listing(app), "deepseek-v4-flash")!;

    expect(declared.manual).toMatchObject({ levels: ["low", "high", "max"], default_level: "high", updated_by: "user_local" });
    expect(levelsOf(declared.effective)).toEqual(["low", "high", "max"]);
    expect(declared.effective?.default_level).toBe("high");
    expect(declared.effective?.source).toBe("manual");
  });

  it("keeps offering a declared model after a probe drops it from the snapshot", async () => {
    const { store, runtimes, app } = setupClaude();
    const revision = store.getRelayConfigForDaemon("local").claude!.revision;
    // It is in the inventory to begin with: this is a model that *left*, not one
    // that was never there.
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision, models: [...GATEWAY_MODELS, "retired-alias"].map(id => ({ id, label: id })),
    });
    declareLevels(store, "claude", "retired-alias", ["low"]);

    // The next probe replaces the snapshot wholesale and the alias is gone.
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision, models: GATEWAY_MODELS.map(id => ({ id, label: id })),
    });
    expect(store.getGatewayModels("local", "claude")?.models.some(model => model.id === "retired-alias")).toBe(false);

    const orphan = row(await listing(app), "retired-alias")!;
    // The snapshot is rewritten on every probe, so a declaration that outlives
    // its model has to stay visible — otherwise the page that created it could
    // never clear it again. It is also what keeps the alias selectable now that a
    // declaration is a source in its own right rather than an annotation on
    // whatever the probe happened to return.
    expect(orphan.manual?.levels).toEqual(["low"]);
    expect(orphan.label).toBe("retired-alias");
    expect(orphan.manual?.state).toBe("effective");
    expect(orphan.effective?.source).toBe("manual");
    expect(levelsOf(orphan.effective)).toEqual(["low"]);

    // And it is still routable: an Agent on the retired id is not stranded.
    const agent = store.createAgent({ name: "retired", provider: "claude", model: "retired-alias", thinkingLevel: "low" });
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtimes[0].id)?.id).toBe(task.id);
  });

  it("does not lose the declaration when the gateway is probed again", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");

    // Re-clicking 立即探测 replaces the snapshot (models = excluded.models) under
    // a new source revision; the declaration lives in its own table on purpose.
    const revision = store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "keep" });
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision,
      models: [...GATEWAY_MODELS, "brand-new-alias"].map(id => ({ id, label: id })),
    });

    const probed = row(await listing(app), "deepseek-v4-flash")!;
    expect(probed.manual?.levels).toEqual(["low", "high", "max"]);
    expect(probed.effective?.source).toBe("manual");
    expect(levelsOf(probed.effective)).toEqual(["low", "high", "max"]);
    expect(row(await listing(app), "brand-new-alias")?.manual).toBeNull();
  });
});

describe("MUL-338 gateway reasoning declarations: a declaration only fills a gap", () => {
  it("does not override the gateway's own reasoning metadata", async () => {
    const { store, app } = setupCodex();
    declareLevels(store, "codex", "gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], "max");

    const declared = row(await listing(app, "codex"), "gpt-6-astra")!;

    // Gateway wins; the declaration is still reported so the page can say so.
    expect(declared.effective?.source).toBe("gateway");
    expect(levelsOf(declared.effective)).toEqual(["low", "high"]);
    expect(declared.manual?.levels).toContain("max");
  });

  it("does not override the Runtime's own report", async () => {
    const { store, app } = setupClaude();
    // The ACP bridge reports the native selector for its own alias.
    declareLevels(store, "claude", "claude-fable-5-1", ["low", "max"], "max");

    const declared = row(await listing(app), "claude-fable-5-1")!;

    expect(declared.effective?.source).toBe("runtime");
    expect(levelsOf(declared.effective)).toEqual(NATIVE_LEVELS);
    expect(declared.manual?.levels).toEqual(["low", "max"]);
  });

  it("treats an uninformative Runtime report as a gap, not a declaration", async () => {
    const { store, app } = setupClaude();
    // A Runtime that answers "unknown" for a gateway-only alias has stated no
    // levels; that is missing information, so the declaration fills it.
    store.registerRuntime({
      name: "claude-uninformative", provider: "claude", workspaceId: "local",
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "anthropic", default: false, thinking: { status: "unknown", supportedLevels: [] } }],
    });
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high"]);

    const declared = row(await listing(app), "deepseek-v4-flash")!;

    expect(declared.effective?.source).toBe("manual");
    expect(levelsOf(declared.effective)).toEqual(["low", "high"]);
  });

  it("outranks the family consensus it is listed above", async () => {
    const { store, app } = setupClaude();
    // `claude-opus-5` has no ACP alias of its own but `opus[1m]` infers one.
    const inferred = row(await listing(app), "claude-opus-5")!;
    expect(inferred.effective?.source).toBe("family");
    expect(levelsOf(inferred.effective)).toEqual(NATIVE_LEVELS);

    declareLevels(store, "claude", "claude-opus-5", ["low", "max"], "max");

    const declared = row(await listing(app), "claude-opus-5")!;
    expect(declared.effective?.source).toBe("manual");
    expect(levelsOf(declared.effective)).toEqual(["low", "max"]);
  });

  it("does not leak a declaration onto any other model", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");

    const body = await listing(app);

    expect(row(body, "deepseek-flash")?.effective).toBeNull();
    expect(row(body, "kimi-k2")?.effective).toBeNull();
    expect(levelsOf(row(body, "deepseek-v4-flash")?.effective)).toEqual(["low", "high", "max"]);
  });
});

describe("MUL-338 gateway reasoning declarations: routing", () => {
  function agentWith(store: ReturnType<typeof createLocalStore>, model: string, thinkingLevel: string) {
    return store.createAgent({ name: `agent-${model}-${thinkingLevel}`, provider: "claude", model, thinkingLevel });
  }

  it("claims at a declared level and blocks one outside the declared set", () => {
    for (const level of ["low", "high", "max"]) {
      // A fresh fleet per level: a Runtime that already took a task is busy, so
      // one Runtime cannot be asked to claim three times here.
      const { store, runtimes } = setupClaude();
      declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
      const agent = agentWith(store, "deepseek-v4-flash", level);
      expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agent)).length).toBe(3);
      const task = store.createTask({ agentId: agent.id, prompt: "run" });
      expect(store.claimTask(runtimes[0].id)?.id).toBe(task.id);
    }

    // A level outside the declaration is still refused — the declaration says what
    // the model offers, not that anything goes.
    const { store, runtimes } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
    const outside = agentWith(store, "deepseek-v4-flash", "medium");
    expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, outside)).length).toBe(0);
    const blocked = store.createTask({ agentId: outside.id, prompt: "run" });
    expect(store.claimTask(runtimes[0].id)).toBeNull();
    expect(store.getTask(blocked.id)?.status).toBe("queued");
  });

  it("keeps the capability wait for a level the declaration does not offer", () => {
    const { store } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
    const outside = store.createTask({ agentId: agentWith(store, "deepseek-v4-flash", "xhigh").id, prompt: "run" });

    expect(store.refreshQueuedCapabilityWaitReasons(Date.now() + 5 * 60_000).updated).toBe(1);

    expect(store.getTask(outside.id)?.waitReason).toContain("等待模型能力恢复");
  });

  it("leaves an undeclared model exactly as it was: schedulable, not applicable", () => {
    const { store, runtimes } = setupClaude();

    // The round-A behaviour for the same alias with no declaration at all.
    const agent = agentWith(store, "deepseek-v4-flash", "high");
    expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agent)).length).toBe(3);
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtimes[0].id)?.id).toBe(task.id);
    expect(store.refreshQueuedCapabilityWaitReasons(Date.now() + 5 * 60_000).updated).toBe(0);
  });

  it("does not regress the live-fleet routing table while a declaration exists", () => {
    // The four combinations from round A
    // (tests/unit/multiremi/claude-gateway-effort-routing.test.ts), replayed with
    // one declaration stored on the same fleet. A declaration names one model and
    // may not change how any other model routes.
    const roundA: Array<{ model: string; thinkingLevel: string; routable: boolean }> = [
      { model: "deepseek-v4-flash", thinkingLevel: "high", routable: true },
      { model: "deepseek-flash", thinkingLevel: "", routable: true },
      { model: "deepseek-flash", thinkingLevel: "high", routable: true },
      { model: "claude-fable-5-1", thinkingLevel: "high", routable: true },
    ];
    for (const { model, thinkingLevel, routable } of roundA) {
      const { store, runtimes } = setupClaude();
      declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
      const agent = agentWith(store, model, thinkingLevel);
      expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agent)).length, `${model}/${thinkingLevel || "none"}`)
        .toBe(routable ? 3 : 0);
      const task = store.createTask({ agentId: agent.id, prompt: "run" });
      expect(store.claimTask(runtimes[0].id)?.id, `${model}/${thinkingLevel || "none"}`).toBe(routable ? task.id : undefined);
    }
  });

  it("adds exactly the announced capability to the declared model", async () => {
    const { store, runtimes, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");

    // Same alias, same level as round A — but now the level is honoured instead of
    // ignored, and the levels the administrator did not announce are refused.
    expect(levelsOf(row(await listing(app), "deepseek-v4-flash")?.effective)).toEqual(["low", "high", "max"]);
    // The same declaration is what the Agent model/effort dropdown reads: the
    // status leaves `unknown` for `supported`, so the levels become selectable.
    const fleet = (await catalogFor(app, "claude"))?.models.find(entry => entry.id === "deepseek-v4-flash");
    expect(fleet?.thinking?.status).toBe("supported");
    expect(levelsOf(fleet?.thinking)).toEqual(["low", "high", "max"]);
    expect(fleet?.thinking_source).toBe("manual");
    for (const level of ["low", "high", "max"]) {
      expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agentWith(store, "deepseek-v4-flash", level))).length, level).toBe(3);
    }
    for (const level of ["minimal", "medium", "xhigh"]) {
      expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agentWith(store, "deepseek-v4-flash", level))).length, level).toBe(0);
    }
    // Every other model keeps its own answer.
    expect(levelsOf(row(await listing(app), "deepseek-flash")?.effective)).toBeUndefined();
    expect(runtimes.filter(runtime => store.runtimeSupportsAgentModel(runtime, agentWith(store, "deepseek-flash", "high"))).length).toBe(3);
  });
});

describe("MUL-338 gateway reasoning declarations: a source in its own right", () => {
  /** One Claude Runtime and no relay config at all: discovery has never run. */
  function setupUndiscovered() {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const runtime = store.registerRuntime({
      name: "claude-0", provider: "claude", workspaceId: "local", models: claudeRuntimeModels(),
    });
    return { store, runtime, app: createMultiremiApp({ store }) };
  }

  function claimable(store: ReturnType<typeof createLocalStore>, modelId: string) {
    return store.createAgent({ name: `claim-${modelId}`, provider: "claude", model: modelId, thinkingLevel: "high" });
  }

  it("adds a model nobody ever discovered when there is no snapshot at all", async () => {
    const { store, runtime, app } = setupUndiscovered();
    expect(store.getGatewayModels("local", "claude")).toBeNull();

    declareLevels(store, "claude", "future-alias", ["low", "high", "max"], "high");

    // The catalog an Agent's selection is validated against shows it — from the
    // declaration, which is the only thing that has ever spoken about this id.
    const listed = (await catalogFor(app, "claude"))?.models.find(entry => entry.id === "future-alias");
    expect(listed?.thinking_source).toBe("manual");
    expect(levelsOf(listed?.thinking)).toEqual(["low", "high", "max"]);
    const created = await app.request("/api/agents", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Future", provider: "claude", model: "future-alias", thinking_level: "high" }),
    });
    expect(created.status).toBe(201);

    // The page agrees with routing, and routing is what the Runtime does.
    const declared = row(await listing(app), "future-alias")!;
    expect(declared.manual?.state).toBe("effective");
    expect(declared.effective?.source).toBe("manual");
    const agent = claimable(store, "future-alias");
    expect(store.runtimeSupportsAgentModel(runtime, agent)).toBe(true);
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);

    // A level outside the declaration is refused, as any other undeclared level is.
    const off = store.createAgent({ name: "Future medium", provider: "claude", model: "future-alias", thinkingLevel: "medium" });
    expect(store.runtimeSupportsAgentModel(runtime, off)).toBe(false);
  });

  it("survives a probe that failed and left the snapshot empty", async () => {
    const { store, runtimes, app } = setupClaude();
    const revision = store.getRelayConfigForDaemon("local").claude!.revision;
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision, models: [], error: "gateway HTTP 500",
    });
    // The failure is the probe's, not the administrator's: the declaration is a
    // separate statement and has to keep working exactly when probing does not.
    expect(store.getGatewayModels("local", "claude")?.lastError).toBe("gateway HTTP 500");

    declareLevels(store, "claude", "future-alias", ["low", "high"], "low");

    const listed = (await catalogFor(app, "claude"))?.models.find(entry => entry.id === "future-alias");
    expect(listed?.thinking_source).toBe("manual");
    expect(levelsOf(listed?.thinking)).toEqual(["low", "high"]);
    const agent = claimable(store, "future-alias");
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(runtimes[0].id)?.id).toBe(task.id);
    // Listing a declaration does not invent the models the failed probe could not
    // fetch: the row exists because it was declared, and says so.
    expect(row(await listing(app), "future-alias")?.effective?.source).toBe("manual");
  });

  it("keeps declaring a model while discovery is switched off", async () => {
    const { store, app } = setupClaude();
    store.setRelayModelDiscovery("local", false);
    declareLevels(store, "claude", "future-alias", ["low"]);

    const models = (await catalogFor(app, "claude"))?.models ?? [];
    // The toggle hides the (possibly stale) snapshot — that is its job.
    expect(models.some(entry => entry.id === "deepseek-v4-flash")).toBe(false);
    // It does not hide an administrator's own declaration, which is not probe data.
    expect(models.find(entry => entry.id === "future-alias")?.thinking_source).toBe("manual");
  });

  it("stores a Codex declaration for a non-member and reports why it is inert", async () => {
    const { store, app } = setupCodex();
    declareLevels(store, "codex", "ghost-model", ["low", "high"]);

    const ghost = row(await listing(app, "codex"), "ghost-model")!;
    // Stored and shown — an administrator may be declaring it for when the gateway
    // offers it — but never dressed up as selectable.
    expect(ghost.manual?.levels).toEqual(["low", "high"]);
    expect(ghost.manual?.state).toBe("blocked");
    expect(ghost.manual?.state_code).toBe("not_in_execution_catalog");
    expect(ghost.effective).toBeNull();
    expect((await catalogFor(app, "codex"))?.models.some(entry => entry.id === "ghost-model")).toBe(false);

    const created = await app.request("/api/agents", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Ghost", provider: "codex", model: "ghost-model", thinking_level: "low" }),
    });
    expect(created.status).toBe(400);
    expect((await created.json()).code).toBe("model_not_in_execution_catalog");
  });

  it("reports an unknown Codex execution catalog as unresolved rather than absent", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "test-key" });
    const app = createMultiremiApp({ store });
    declareLevels(store, "codex", "ghost-model", ["low"]);

    const ghost = row(await listing(app, "codex"), "ghost-model")!;
    expect(ghost.manual?.state).toBe("blocked");
    // Nothing has been probed yet, so the honest answer is "not decided", not
    // "this model is not in the catalog".
    expect(ghost.manual?.state_code).toBe("execution_catalog_unknown");
  });
});

describe("MUL-338 gateway reasoning declarations: the group-scoped catalog", () => {
  // Two Claude members that both offer the same gateway model, one report each.
  function setupGroup(reports: Array<MultiremiRuntimeModelThinking | undefined>) {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "claude", {
      fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "test-key",
    });
    store.saveGatewayModels("local", "claude", {
      sourceRevision: revision, models: GATEWAY_MODELS.map(id => ({ id, label: id })),
    });
    const runtimes = reports.map((thinking, index) => store.registerRuntime({
      name: `member-${index}`, provider: "claude", workspaceId: "local", executionGroupId: "reasoning-group",
      models: [...claudeRuntimeModels(), {
        id: "deepseek-v4-flash", label: "deepseek-v4-flash", provider: "anthropic", default: false,
        ...(thinking ? { thinking } : {}),
      }],
    }));
    return { store, runtimes, app: createMultiremiApp({ store }) };
  }

  async function groupModel(app: ReturnType<typeof createMultiremiApp>) {
    const response = await app.request("/api/models?execution_group_id=reasoning-group");
    const { providers } = await response.json() as { providers: FleetProviderModelsResponse[] };
    return providers.find(entry => entry.provider === "claude")?.models.find(entry => entry.id === "deepseek-v4-flash");
  }

  async function runtimeModel(app: ReturnType<typeof createMultiremiApp>, runtimeId: string) {
    const response = await app.request(`/api/models?workspace_id=local&runtime_id=${runtimeId}`);
    const { providers } = await response.json() as { providers: FleetProviderModelsResponse[] };
    return providers.find(entry => entry.provider === "claude")?.models.find(entry => entry.id === "deepseek-v4-flash");
  }

  it("names the source when every member agrees on it", async () => {
    // Both members report the model themselves, so the group's intersection is
    // still that report and can say so.
    const { app } = setupGroup([reasoning(NATIVE_LEVELS, "medium"), reasoning(NATIVE_LEVELS, "medium")]);

    const model = await groupModel(app);
    expect(levelsOf(model?.thinking)).toEqual(NATIVE_LEVELS);
    expect(model?.thinking_source).toBe("runtime");
  });

  it("omits the source rather than attributing the intersection to one member", async () => {
    // member-0 states the levels; member-1 leaves the model to the administrator's
    // declaration, so the two members disagree about who spoke for the model.
    const { store, runtimes, app } = setupGroup([reasoning(NATIVE_LEVELS, "medium"), undefined]);
    declareLevels(store, "claude", "deepseek-v4-flash", NATIVE_LEVELS, "medium");

    expect((await runtimeModel(app, runtimes[0].id))?.thinking_source).toBe("runtime");
    expect((await runtimeModel(app, runtimes[1].id))?.thinking_source).toBe("manual");
    // The intersection is still reported — with levels both members can honour —
    // but naming either member's source for it would misattribute the other's.
    const model = await groupModel(app);
    expect(levelsOf(model?.thinking)).toEqual(NATIVE_LEVELS);
    expect(model?.thinking_source).toBeUndefined();
  });
});

describe("MUL-338 gateway reasoning declarations: the write side", () => {
  function agentWith(store: ReturnType<typeof createLocalStore>, model: string, thinkingLevel: string) {
    return store.createAgent({ name: `agent-${model}-${thinkingLevel}`, provider: "claude", model, thinkingLevel });
  }

  it("keeps a stored level the declaration authorises", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
    const agent = agentWith(store, "deepseek-v4-flash", "high");

    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers, body: JSON.stringify({ description: "metadata-only edit" }),
    });

    expect(response.status).toBe(200);
    // A declaration makes the level real, so the convergence that heals a
    // level-less model must not touch it.
    expect(store.getAgent(agent.id)?.thinkingLevel).toBe("high");
  });

  it("converges a stored level the declaration does not authorise", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
    const agent = agentWith(store, "deepseek-v4-flash", "medium");

    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers, body: JSON.stringify({ description: "metadata-only edit" }),
    });

    expect(response.status).toBe(200);
    // The declaration exists but does not offer this level: it is a leftover like
    // any other, and it may not be silently kept.
    expect(store.getAgent(agent.id)?.thinkingLevel ?? "").toBe("");
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    expect(store.claimTask(store.listRuntimes()[0].id)?.id).toBe(task.id);
  });

  it("still rejects a level the caller names while changing the selection", async () => {
    const { store, app } = setupClaude();
    declareLevels(store, "claude", "deepseek-v4-flash", ["low", "high", "max"], "high");
    const agent = agentWith(store, "deepseek-flash", "");

    const response = await app.request(`/api/agents/${agent.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash", thinking_level: "medium" }),
    });

    // Named-and-changing stays a request: the caller is told, not rewritten.
    expect(response.status).toBe(400);
    expect(store.getAgent(agent.id)?.thinkingLevel ?? "").toBe("");
  });
});

describe("MUL-338 gateway reasoning declarations: #220 and the strict engines", () => {
  it("keeps a Codex model without a declaration strictly blocked", () => {
    const { store } = setupCodex();

    const agent = store.createAgent({ name: "codex levelless", provider: "codex", model: "gpt-levelless", thinkingLevel: "high" });

    // No manual declaration: the engine's silence is still a statement.
    expect(store.listGatewayModelReasoning("local", "codex")).toEqual([]);
    expect(store.runtimeSupportsAgentModel(store.registerRuntime({
      name: "codex-vendor", provider: "codex", workspaceId: "local",
      models: [{ id: "gpt-levelless", label: "GPT", provider: "openai", default: true }],
    }), agent)).toBe(false);
  });

  it("keeps the Codex execution-catalog membership gate intact", async () => {
    const { store, app } = setupCodex();
    declareLevels(store, "codex", "gpt-ghost", ["low", "high"]);

    const codex = await catalogFor(app, "codex");

    // A declaration is a statement about a model, not a way to add one to the
    // execution catalog.
    expect(catalogAllowsModel(codex, "gpt-ghost")).toBe(false);
    expect(catalogAllowsModel(codex, "gpt-6-astra")).toBe(true);
  });

  it("surfaces a declared Codex model at exactly the declared levels", async () => {
    const { store, app } = setupCodex();
    declareLevels(store, "codex", "gpt-levelless", ["low", "high"], "low");

    const codex = await catalogFor(app, "codex");
    const model = codex?.models.find(entry => entry.id === "gpt-levelless");

    expect(model?.thinking?.status).toBe("supported");
    expect(model?.thinking?.supported_levels.map(level => level.value)).toEqual(["low", "high"]);
    expect(model?.thinking_source).toBe("manual");
    // The model the catalog does declare keeps its own levels.
    const declared = codex?.models.find(entry => entry.id === "gpt-6-astra");
    expect(declared?.thinking?.supported_levels.map(level => level.value)).toEqual(["low", "high"]);
    expect(declared?.thinking_source).toBe("gateway");
    // The allowed enum is the engine's, not Claude's.
    expect((await listing(app, "codex")).allowed_levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("displaces the family inference, which is the only thing it outranks", async () => {
    const { store, app } = setupClaude();
    // `claude-sonnet-5` has no ACP alias of its own: its levels came from the
    // `sonnet` family inference, which is an inference, not a report.
    const inferred = (await catalogFor(app, "claude"))?.models.find(entry => entry.id === "claude-sonnet-5");
    expect(inferred?.thinking?.supported_levels.map(level => level.value)).toEqual(NATIVE_LEVELS);
    expect(inferred?.thinking_source).toBe("family");

    declareLevels(store, "claude", "claude-sonnet-5", ["low", "max"], "max");

    const declared = (await catalogFor(app, "claude"))?.models.find(entry => entry.id === "claude-sonnet-5");
    expect(declared?.thinking?.supported_levels.map(level => level.value)).toEqual(["low", "max"]);
    expect(declared?.thinking_source).toBe("manual");
  });
});

describe("MUL-338 gateway reasoning declarations: the write endpoint", () => {
  it("records the declaration and answers with the effective listing", async () => {
    const { app } = setupClaude();

    const response = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash", levels: ["low", "high", "max"], default_level: "high" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Awaited<ReturnType<typeof listing>> & { deleted: boolean };
    expect(body.deleted).toBe(false);
    const declared = row(body, "deepseek-v4-flash")!;
    expect(declared.manual?.levels).toEqual(["low", "high", "max"]);
    expect(declared.manual?.updated_by).toBeTruthy();
    expect(Number.isFinite(Date.parse(declared.manual!.updated_at))).toBe(true);
    expect(declared.effective?.source).toBe("manual");
  });

  it("clears a declaration with an empty level set", async () => {
    const { app } = setupClaude();
    await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash", levels: ["low", "high"] }),
    });

    const cleared = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT", headers, body: JSON.stringify({ model: "deepseek-v4-flash", levels: [] }),
    });

    expect(cleared.status).toBe(200);
    const body = await cleared.json() as Awaited<ReturnType<typeof listing>> & { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(row(body, "deepseek-v4-flash")?.manual).toBeNull();

    const again = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT", headers, body: JSON.stringify({ model: "deepseek-v4-flash", levels: [] }),
    });
    expect((await again.json() as { deleted: boolean }).deleted).toBe(false);
  });

  it("rejects a level outside the engine's enum", async () => {
    const { store, app } = setupClaude();

    for (const levels of [["ultra"], ["minimal"], ["low ", "high"], ["LOW"]]) {
      const response = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
        method: "PUT", headers, body: JSON.stringify({ model: "deepseek-v4-flash", levels }),
      });
      expect(response.status).toBe(400);
    }
    // "minimal" is the Codex enum's extra member and must stay engine-scoped.
    const codex = await app.request("/api/workspaces/local/relay-config/codex/reasoning-levels", {
      method: "PUT", headers, body: JSON.stringify({ model: "gpt-levelless", levels: ["minimal"] }),
    });
    expect(codex.status).toBe(200);
    expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")).toBeNull();
  });

  it("rejects a default level the declaration does not contain", async () => {
    const { store, app } = setupClaude();

    const response = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT", headers,
      body: JSON.stringify({ model: "deepseek-v4-flash", levels: ["low", "high"], default_level: "max" }),
    });

    expect(response.status).toBe(400);
    expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")).toBeNull();
  });

  it("rejects a malformed request", async () => {
    const { app } = setupClaude();

    const cases: Array<Record<string, unknown>> = [
      { levels: ["low"] },
      { model: "deepseek-v4-flash" },
      { model: "deepseek-v4-flash", levels: "low" },
      { model: "   ", levels: ["low"] },
    ];
    for (const payload of cases) {
      const response = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
        method: "PUT", headers, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }

    const badEngine = await app.request("/api/workspaces/local/relay-config/gemini/reasoning-levels");
    expect(badEngine.status).toBe(400);
  });

  it("requires a workspace administrator", async () => {
    const store = createLocalStore();
    store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const asMember = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT",
      headers: { Authorization: `Bearer ${member.token}`, ...headers },
      body: JSON.stringify({ model: "deepseek-v4-flash", levels: ["low"] }),
    });
    expect(asMember.status).toBe(403);

    const readAsMember = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      headers: { Authorization: `Bearer ${member.token}` },
    });
    expect(readAsMember.status).toBe(403);

    const asAdmin = await app.request("/api/workspaces/local/relay-config/claude/reasoning-levels", {
      method: "PUT",
      headers: { Authorization: "Bearer MASTER", ...headers },
      body: JSON.stringify({ model: "deepseek-v4-flash", levels: ["low"] }),
    });
    expect(asAdmin.status).toBe(200);
    // A refused request must not have written anything on its way out.
    expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")?.levels).toEqual(["low"]);
  });
});
