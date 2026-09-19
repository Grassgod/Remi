import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import {
  probeGatewayModels,
  type HttpGet,
  type HttpResponse,
} from "@multiremi/relay/discovery.js";
import { MultiremiStore } from "@multiremi/store.js";
import { codexNativeModel } from "../../fixtures/codex-native-catalog.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const CLAUDE_FRAG = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } });
const CODEX_FRAG = ['model_provider = "OpenAI"', "[model_providers.OpenAI]", 'base_url = "https://vip.openremi.fun/v1"'].join("\n");

function ok(json: unknown): HttpResponse {
  return { status: 200, text: JSON.stringify(json) };
}

describe("relay gateway probe", () => {
  it("refreshes the Claude catalog and reports no reasoning levels instead of inventing them", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "sk-ant" });
    const urls: string[] = [];
    const httpGet: HttpGet = async (url) => {
      urls.push(url);
      return ok({ data: [
        { id: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
        { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
      ] });
    };

    const result = await probeGatewayModels(store, "local", "claude", { httpGet });

    expect(urls).toEqual(["https://ai.openremi.fun/v1/models"]);
    expect(result.engine).toBe("claude");
    expect(result.status).toBe("ready");
    expect(result.error).toBeNull();
    expect(result.last_success_at).not.toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "claude-fable-5-1"]);
    // Claude's /v1/models carries no effort field: the snapshot says "nobody
    // declared levels" by omission rather than fabricating a level set.
    expect(result.models.every((model) => model.thinking === undefined)).toBe(true);
    expect(store.getGatewayModels("local", "claude")?.lastSuccessAt).toBe(result.last_success_at);
  });

  it("carries the Codex capability catalog's reasoning levels through the snapshot", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "sk-codex" });
    const httpGet: HttpGet = async (url) => url.endsWith("/backend-api/codex/models")
      ? ok({ models: [codexNativeModel({
          slug: "gpt-6-astra",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
          ],
          default_reasoning_level: "high",
        })] })
      : ok({ data: [{ id: "gpt-6-astra" }] });

    const result = await probeGatewayModels(store, "local", "codex", { httpGet });

    expect(result.status).toBe("ready");
    expect(result.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(result.models[0]?.thinking?.status).toBe("supported");
    expect(result.models[0]?.thinking?.supported_levels.map((level) => level.value)).toEqual(["low", "high"]);
    expect(result.models[0]?.thinking?.default_level).toBe("high");
  });

  it("reports a sanitized failure and keeps the last known catalog", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    const revision = store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "TOPSECRET" });
    store.saveGatewayModels("local", "claude", { sourceRevision: revision, models: [{ id: "old-model", label: "Old model" }] });
    const httpGet: HttpGet = async () => { throw new Error("gateway refused TOPSECRET"); };

    const result = await probeGatewayModels(store, "local", "claude", { httpGet });

    expect(result.status).toBe("error");
    expect(result.error).toBe("gateway refused [redacted]");
    expect(result.models.map((model) => model.id)).toEqual(["old-model"]);
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
  });

  it("answers an explicit unknown snapshot when discovery never runs", async () => {
    const store = createLocalStore();
    let called = 0;
    const result = await probeGatewayModels(store, "local", "claude", {
      httpGet: async () => { called++; throw new Error("must not fetch"); },
    });

    expect(called).toBe(0);
    expect(result).toEqual({
      engine: "claude",
      status: "unknown",
      error: null,
      models: [],
      last_success_at: null,
    });
  });

  it("returns within the bounded wait when the gateway never answers", async () => {
    const store = createLocalStore();
    store.setRelayModelDiscovery("local", true);
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "sk-ant" });
    const startedAt = Date.now();

    const result = await probeGatewayModels(store, "local", "claude", {
      httpGet: () => new Promise<HttpResponse>(() => {}),
      timeoutMs: 20,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).toBe("unknown");
    expect(result.models).toEqual([]);
  });
});

describe("relay probe route", () => {
  async function setup() {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAG, tokenOp: "set", authToken: "sk-ant" });
    // model discovery stays off here: the route must answer from the cached
    // snapshot without reaching the network inside a test.
    const owner = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "agent", userId: "local" });
    store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
    return { app: createMultiremiApp({ store, authToken: "MASTER" }), ownerToken: owner.token, memberToken: member.token };
  }

  it("answers the snapshot projection for a workspace administrator", async () => {
    const { app } = await setup();
    const res = await app.request("/api/workspaces/local/relay-config/claude/probe", {
      method: "POST",
      headers: { Authorization: "Bearer MASTER", "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      engine: "claude",
      status: "unknown",
      error: null,
      models: [],
      last_success_at: null,
    });
  });

  it("rejects a non-admin member and an unknown engine", async () => {
    const { app, memberToken } = await setup();
    const asMember = await app.request("/api/workspaces/local/relay-config/claude/probe", {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(asMember.status).toBe(403);

    const badEngine = await app.request("/api/workspaces/local/relay-config/gemini/probe", {
      method: "POST",
      headers: { Authorization: "Bearer MASTER", "content-type": "application/json" },
      body: "{}",
    });
    expect(badEngine.status).toBe(400);
  });
});
