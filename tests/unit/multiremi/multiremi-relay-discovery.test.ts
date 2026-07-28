import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { discoverGatewayModels, type HttpGet, type HttpResponse } from "@multiremi/relay/discovery.js";

function createStore(): MultiremiStore {
  const store = new MultiremiStore(new Database(":memory:"));
  store.ensureLocalWorkspace();
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

  it("queries codex /models and dedups by id", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const s = stub((url) => {
      expect(url).toBe("https://vip.openremi.fun/v1/models");
      return ok({ data: [
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
        { id: "gpt-5.6-sol", display_name: "dup" },
        { id: "gpt-5.5" },
      ] });
    });
    await discoverGatewayModels(store, "local", "codex", s.get);
    const models = store.getGatewayModels("local", "codex")?.models;
    expect(models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.5", label: "gpt-5.5" }]);
  });

  it("keeps last-known-good models AND source_revision on gateway failure", async () => {
    const store = createStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    await discoverGatewayModels(store, "local", "codex", stub(() => ok({ data: [{ id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }] })).get);
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
