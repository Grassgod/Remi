import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { discoverGatewayModels, refreshStaleGatewayModels, type HttpGet, type HttpResponse } from "@multiremi/relay/discovery.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createStore(): MultiremiStore {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  return store;
}

/** A recording http stub — no network, no DNS. */
function stub(fn: (url: string, headers: Record<string, string>) => HttpResponse): { get: HttpGet; calls: number } {
  const box = { calls: 0, get: (async (url, headers) => { box.calls++; return fn(url, headers); }) as HttpGet };
  return box;
}
function ok(json: unknown): HttpResponse { return { status: 200, text: JSON.stringify(json) }; }

const CLAUDE_FRAG = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } });
const CODEX_FRAG = ['model_provider = "OpenAI"', "[model_providers.OpenAI]", 'base_url = "https://vip.openremi.fun/v1"'].join("\n");

describe("relay model discovery", () => {
  it("refreshes pre-native snapshots immediately and respects a fresh ready catalog", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Legacy catalog refresh" });
    store.setRelayModelDiscovery(workspace.id, true);
    const revision = store.upsertRelayConfig(workspace.id, "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    store.saveGatewayModels(workspace.id, "codex", { sourceRevision: revision, models: [{ id: "inventory-only", label: "Legacy inventory" }] });
    const s = stub(url => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [{ slug: "native-model", supported_reasoning_levels: [] }] })
      : ok({ data: [{ id: "inventory-only" }, { id: "native-model" }] }));
    refreshStaleGatewayModels(store, workspace.id, s.get);
    await Bun.sleep(0); // allow the injected async transport and snapshot write to finish
    expect(s.calls).toBe(2);
    expect(store.getGatewayModels(workspace.id, "codex")?.nativeCatalogStatus).toBe("ready");
    expect(store.getGatewayModels(workspace.id, "codex")?.models.map(model => model.id)).toEqual(["native-model"]);
    const readyWorkspace = store.createWorkspace({ name: "Fresh native catalog" });
    store.setRelayModelDiscovery(readyWorkspace.id, true);
    const readyRevision = store.upsertRelayConfig(readyWorkspace.id, "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    store.saveGatewayModels(readyWorkspace.id, "codex", {
      sourceRevision: readyRevision, nativeCatalogStatus: "ready", models: [{ id: "native-model", label: "Native" }],
    });
    // This workspace has no retry backoff; only freshness may suppress discovery.
    refreshStaleGatewayModels(store, readyWorkspace.id, s.get);
    await Bun.sleep(0);
    expect(s.calls).toBe(2);
  });

  it("queries claude /v1/models with bearer + anthropic-version and caches models", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "sk-ant" });
    let seenUrl = ""; let seenAuth = ""; let seenVersion = "";
    const s = stub((url, headers) => {
      seenUrl = url; seenAuth = headers.Authorization ?? ""; seenVersion = headers["anthropic-version"] ?? "";
      return ok({ data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }] });
    });
    await discoverGatewayModels(store, "local", "claude", s.get);
    expect(seenUrl).toBe("https://ai.openremi.fun/v1/models");
    expect(seenAuth).toBe("Bearer sk-ant");
    expect(seenVersion).toBe("2023-06-01");
    expect(store.getGatewayModels("local", "claude")?.models).toEqual([{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }]);
  });

  it("queries codex /models and origin capability catalog, and dedups by id", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const s = stub((url) => {
      if (url === "https://vip.openremi.fun/backend-api/codex/models") return ok({ models: [
        { slug: "gpt-5.6-sol" }, { slug: "gpt-5.6-sol" }, { slug: "gpt-5.5" },
      ] });
      expect(url).toBe("https://vip.openremi.fun/v1/models");
      return ok({ data: [
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
        { id: "gpt-5.6-sol", display_name: "dup" },
        { id: "gpt-5.5" },
      ] });
    });
    await discoverGatewayModels(store, "local", "codex", s.get);
    const models = store.getGatewayModels("local", "codex")?.models;
    expect(models).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", thinking: { status: "unknown", supportedLevels: [] } },
      { id: "gpt-5.5", label: "gpt-5.5", thinking: { status: "unknown", supportedLevels: [] } },
    ]);
    expect(s.calls).toBe(2);
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("ready");
  });

  it("persists generic effort values, descriptions and per-model defaults without prompt templates", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const s = stub((url, headers) => {
      expect(headers.Authorization).toBe("Bearer sk-codex");
      return url.endsWith("/backend-api/codex/models") ? ok({ models: [{
        slug: "custom-model",
        default_reasoning_level: "deep",
        supported_reasoning_levels: [{ effort: "brief", description: "Quick result" }, { effort: "deep", description: "Detailed result" }],
        model_messages: { instructions_template: "Must not enter the control-plane snapshot" },
      }] }) : ok({ data: [{ id: "custom-model", display_name: "Custom" }] });
    });
    await discoverGatewayModels(store, "local", "codex", s.get);
    expect(store.getGatewayModels("local", "codex")?.models).toEqual([{
      id: "custom-model", label: "Custom", thinking: {
        status: "supported", defaultLevel: "deep", supportedLevels: [
          { value: "brief", label: "brief", description: "Quick result" },
          { value: "deep", label: "deep", description: "Detailed result" },
        ],
      },
    }]);
  });

  it("distinguishes missing, empty and invalid declarations per model", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const declarations = [
      { slug: "missing" },
      { slug: "empty", supported_reasoning_levels: [] },
      { slug: "invalid-array", supported_reasoning_levels: "high" },
      { slug: "invalid-level", supported_reasoning_levels: [{ effort: 42 }] },
      { slug: "invalid-default", supported_reasoning_levels: [{ effort: "high" }], default_reasoning_level: "other" },
      { slug: "missing-default", supported_reasoning_levels: [{ effort: "high" }] },
    ];
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: declarations }) : ok({ data: declarations.map(({ slug }) => ({ id: slug })) })).get);
    expect(store.getGatewayModels("local", "codex")?.models.map((model) => model.thinking?.status))
      .toEqual(["unknown", "unsupported", "error", "error", "error", "supported"]);
  });

  it("omits native models that Codex hides or cannot use through the API", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [
        { slug: "hidden", visibility: "hide", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }] },
        { slug: "unavailable", visibility: "list", supported_in_api: false, supported_reasoning_levels: [{ effort: "high" }] },
        { slug: "visible", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }] },
      ] }) : ok({ data: ["hidden", "unavailable", "visible", "unknown"].map(id => ({ id })) })).get);
    expect(store.getGatewayModels("local", "codex")?.models.map(model => [model.id, model.thinking?.status]))
      .toEqual([["visible", "supported"]]);
  });

  it("takes membership from the native directory, including native-only models and their labels", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [
        { slug: "native-only", display_name: "Native model", supported_reasoning_levels: [{ effort: "deep" }], default_reasoning_level: "deep" },
        { slug: "shared", display_name: "Native label" },
      ] }) : ok({ data: [{ id: "inventory-only" }, { id: "shared", display_name: "Inventory label" }] })).get);
    const snapshot = store.getGatewayModels("local", "codex")!;
    expect(snapshot.nativeCatalogStatus).toBe("ready");
    expect(snapshot.models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "native-only", label: "Native model" }, { id: "shared", label: "Inventory label" },
    ]);
    expect(snapshot.models[0].thinking?.defaultLevel).toBe("deep");
  });

  it("preserves an authoritative empty selectable set when the native directory contains only hidden models", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [{ slug: "hidden", visibility: "hide", supported_in_api: true }] })
      : ok({ data: [{ id: "inventory-only" }, { id: "hidden" }] })).get);
    const snapshot = store.getGatewayModels("local", "codex")!;
    expect(snapshot.models).toEqual([]);
    expect(snapshot.nativeCatalogStatus).toBe("ready");
    expect(snapshot.lastError).toBeNull();
  });

  for (const failure of ["http", "invalid-json", "invalid-shape", "empty-native", "invalid-slug", "timeout"] as const) {
    it(`keeps model inventory and reports capability ${failure} failure`, async () => {
      const store = createStore();
      store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "test-private-credential" });
      await discoverGatewayModels(store, "local", "codex", stub((url) => {
        if (!url.endsWith("/backend-api/codex/models")) return ok({ data: [{ id: "custom-model" }] });
        if (failure === "timeout") throw new Error("timed out test-private-credential\nrequest");
        if (failure === "invalid-json") return { status: 200, text: "test-private-credential invalid JSON" };
        if (failure === "invalid-shape") return ok({ models: null });
        if (failure === "empty-native") return ok({ models: [] });
        if (failure === "invalid-slug") return ok({ models: [{ slug: 7 }] });
        return { status: 503, text: "test-private-credential" };
      }).get);
      const snapshot = store.getGatewayModels("local", "codex")!;
      expect(snapshot.models[0].id).toBe("custom-model");
      expect(snapshot.models[0].thinking?.status).toBe("error");
      expect(snapshot.models[0].thinking?.supportedLevels).toEqual([]);
      expect(snapshot.lastError).toBeTruthy();
      expect(snapshot.nativeCatalogStatus).toBe("error");
      expect(JSON.stringify(snapshot)).not.toContain("test-private-credential");
    });
  }

  it("fences a late capability response behind a newer relay revision", async () => {
    const store = createStore();
    const revision = store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => {
      if (!url.endsWith("/backend-api/codex/models")) return ok({ data: [{ id: "old-model" }] });
      const newer = store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "keep" });
      store.saveGatewayModels("local", "codex", { sourceRevision: newer, nativeCatalogStatus: "error", error: "newer failure", models: [{ id: "new-model", label: "New" }] });
      return ok({ models: [{ slug: "old-model", supported_reasoning_levels: [] }] });
    }).get);
    expect(store.getGatewayModels("local", "codex")?.sourceRevision).toBe(revision + 1);
    expect(store.getGatewayModels("local", "codex")?.models[0].id).toBe("new-model");
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("error");
  });

  it("keeps last-known-good models AND source_revision on gateway failure", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => ok(url.endsWith("/backend-api/codex/models")
      ? { models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }], default_reasoning_level: "high" }] }
      : { data: [{ id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }] })).get);
    const successRev = store.getGatewayModels("local", "codex")!.sourceRevision;
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "keep" }); // bumps revision
    await discoverGatewayModels(store, "local", "codex", stub(() => ({ status: 401, text: "nope" })).get);
    const snap = store.getGatewayModels("local", "codex");
    expect(snap?.models[0].id).toBe("gpt-5.6-sol"); // last-known-good retained
    expect(snap?.lastError).toContain("401");
    // a failed discovery must NOT advance source_revision — stale must not look fresh
    expect(snap?.sourceRevision).toBe(successRev);
  });

  it("skips when discovery disabled; clears the snapshot when the token is removed", async () => {
    const store = createStore();
    store.setRelayModelDiscovery("local", false);
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "sk-ant" });
    const s1 = stub(() => ok({ data: [] }));
    await discoverGatewayModels(store, "local", "claude", s1.get);
    expect(s1.calls).toBe(0); // discovery disabled → no request

    store.setRelayModelDiscovery("local", true);
    store.saveGatewayModels("local", "claude", { models: [{ id: "old", label: "Old" }], sourceRevision: 1 });
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "clear" });
    const s2 = stub(() => ok({ data: [] }));
    await discoverGatewayModels(store, "local", "claude", s2.get);
    expect(s2.calls).toBe(0); // no token → no request
    expect(store.getGatewayModels("local", "claude")?.models).toEqual([]); // stale catalog dropped
  });
});
