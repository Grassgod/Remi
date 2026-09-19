import { loadCodexModelCatalog } from "@daemon/agent-runtime/relay-sync.js";
import { codexNativeModel } from "../../fixtures/codex-native-catalog.js";
import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { discoverGatewayModels, refreshPreNativeCodexSnapshots, type HttpGet, type HttpResponse } from "@multiremi/relay/discovery.js";
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
  it("repairs a pre-native codex snapshot at boot and leaves a ready catalog alone", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Legacy catalog refresh" });
    store.setRelayModelDiscovery(workspace.id, true);
    const revision = store.upsertRelayConfig(workspace.id, "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    store.saveGatewayModels(workspace.id, "codex", { sourceRevision: revision, models: [{ id: "inventory-only", label: "Legacy inventory" }] });
    const s = stub(url => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [codexNativeModel({ slug: "native-model", supported_reasoning_levels: [] })] })
      : ok({ data: [{ id: "inventory-only" }, { id: "native-model" }] }));
    refreshPreNativeCodexSnapshots(store, s.get);
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
    // A snapshot that already carries native authority is not repaired.
    refreshPreNativeCodexSnapshots(store, s.get);
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
        codexNativeModel({ slug: "gpt-5.6-sol" }), codexNativeModel({ slug: "gpt-5.6-sol" }), codexNativeModel({ slug: "gpt-5.5" }),
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
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", thinking: { status: "unsupported", supportedLevels: [] } },
      { id: "gpt-5.5", label: "gpt-5.5", thinking: { status: "unsupported", supportedLevels: [] } },
    ]);
    expect(s.calls).toBe(2);
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("ready");
  });

  it("persists generic effort values, descriptions and per-model defaults without prompt templates", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const s = stub((url, headers) => {
      expect(headers.Authorization).toBe("Bearer sk-codex");
      return url.endsWith("/backend-api/codex/models") ? ok({ models: [codexNativeModel({
        slug: "custom-model",
        default_reasoning_level: "deep",
        supported_reasoning_levels: [{ effort: "brief", description: "Quick result" }, { effort: "deep", description: "Detailed result" }],
        model_messages: { instructions_template: "Must not enter the control-plane snapshot" },
      })] }) : ok({ data: [{ id: "custom-model", display_name: "Custom" }] });
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

  it("distinguishes explicit empty levels, invalid default and absent default in loadable catalogs", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const declarations = [
      codexNativeModel({ slug: "empty", supported_reasoning_levels: [] }),
      codexNativeModel({ slug: "invalid-default", supported_reasoning_levels: [{ effort: "high", description: "" }], default_reasoning_level: "other" }),
      codexNativeModel({ slug: "missing-default", supported_reasoning_levels: [{ effort: "high", description: "" }] }),
    ];
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: declarations }) : ok({ data: declarations.map(({ slug }) => ({ id: slug })) })).get);
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("ready");
    expect(store.getGatewayModels("local", "codex")?.models.map((model) => model.thinking?.status))
      .toEqual(["unsupported", "error", "supported"]);
    expect(store.getGatewayModels("local", "codex")?.models[2].thinking?.defaultLevel).toBeUndefined();
  });

  it("rejects the same incomplete native directory in server discovery and daemon loading", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "fixture-key" });
    const partial = { slug: "partial-native", display_name: "Partial native", visibility: "list", supported_in_api: true,
      default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high", description: "" }] };
    const incompleteModels = [
      partial,
      ...["slug", "display_name", "shell_type", "visibility", "supported_in_api", "support_verbosity", "priority",
        "truncation_policy", "experimental_supported_tools", "supported_reasoning_levels", "model_messages"]
        .map(key => {
          const model = codexNativeModel({ slug: "partial-native" });
          delete model[key];
          return model;
        }),
      codexNativeModel({ slug: "partial-native", supported_reasoning_levels: "high" }),
      codexNativeModel({ slug: "partial-native", supported_reasoning_levels: [{ effort: 42 }] }),
      codexNativeModel({ slug: "partial-native", supported_reasoning_levels: [{ effort: "high" }] }),
      codexNativeModel({ slug: "partial-native", visibility: "hide", shell_type: undefined }),
    ];
    for (const incomplete of incompleteModels) {
      // One malformed member rejects the entire document, even beside valid or hidden models.
      const response = ok({ models: [codexNativeModel({ slug: "healthy-native" }), incomplete] });
      await discoverGatewayModels(store, "local", "codex", stub(url => url.endsWith("/backend-api/codex/models")
        ? response : ok({ data: [{ id: "partial-native" }, { id: "healthy-native" }] })).get);
      const loaded = await loadCodexModelCatalog(CODEX_FRAG, "fixture-key", async () => response);
      const snapshot = store.getGatewayModels("local", "codex")!;
      expect(loaded.status).toBe("error");
      expect(snapshot.nativeCatalogStatus).toBe("error");
      expect(snapshot.models.map(model => model.id)).toEqual(["partial-native", "healthy-native"]);
      expect(snapshot.models.every(model => model.thinking?.status === "error")).toBe(true);
      expect(snapshot.lastError).toContain("incomplete or invalid native model metadata");
    }
    const valid = ok({ models: [codexNativeModel({ slug: "healthy-native" })] });
    await discoverGatewayModels(store, "local", "codex", stub(url => url.endsWith("/backend-api/codex/models")
      ? valid : ok({ data: [{ id: "healthy-native" }] })).get);
    expect((await loadCodexModelCatalog(CODEX_FRAG, "fixture-key", async () => valid)).status).toBe("loaded");
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("ready");
  });

  it("omits native models that Codex hides or cannot use through the API", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [
        codexNativeModel({ slug: "hidden", visibility: "hide", supported_in_api: true, supported_reasoning_levels: [{ effort: "high", description: "" }] }),
        codexNativeModel({ slug: "unavailable", visibility: "list", supported_in_api: false, supported_reasoning_levels: [{ effort: "high", description: "" }] }),
        codexNativeModel({ slug: "visible", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high", description: "" }] }),
      ] }) : ok({ data: ["hidden", "unavailable", "visible", "unknown"].map(id => ({ id })) })).get);
    expect(store.getGatewayModels("local", "codex")?.models.map(model => [model.id, model.thinking?.status]))
      .toEqual([["visible", "supported"]]);
  });

  it("takes membership from the native directory, including native-only models and their labels", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [
        codexNativeModel({ slug: "native-only", display_name: "Native model", supported_reasoning_levels: [{ effort: "deep", description: "" }], default_reasoning_level: "deep" }),
        codexNativeModel({ slug: "shared", display_name: "Native label" }),
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
      ? ok({ models: [codexNativeModel({ slug: "hidden", visibility: "hide", supported_in_api: true })] })
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
      return ok({ models: [codexNativeModel({ slug: "old-model", supported_reasoning_levels: [] })] });
    }).get);
    expect(store.getGatewayModels("local", "codex")?.sourceRevision).toBe(revision + 1);
    expect(store.getGatewayModels("local", "codex")?.models[0].id).toBe("new-model");
    expect(store.getGatewayModels("local", "codex")?.nativeCatalogStatus).toBe("error");
  });

  it("keeps last-known-good models AND source_revision on gateway failure", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub((url) => ok(url.endsWith("/backend-api/codex/models")
      ? { models: [codexNativeModel({ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high", description: "" }], default_reasoning_level: "high" })] }
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
