import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const api = () => new RuntimesEndpoints(new HttpClient("https://api.example.test"));

afterEach(() => vi.unstubAllGlobals());

describe("relay probe endpoint", () => {
  it("POSTs to the probe route and keeps model effort metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      engine: "codex",
      status: "ready",
      error: null,
      models: [{
        id: "gpt-6-astra",
        label: "Astra",
        thinking: { status: "supported", supported_levels: [{ value: "high", label: "High" }], default_level: "high" },
      }],
      last_success_at: "2026-09-19T06:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().probeRelayEngine("ws-1", "codex");

    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/codex/probe");
    expect(fetch.mock.calls[0]![1].method).toBe("POST");
    expect(result.models[0]?.thinking?.supported_levels).toEqual([{ value: "high", label: "High" }]);
    expect(result.status).toBe("ready");
  });

  it("accepts a Claude snapshot with no declared reasoning levels", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      engine: "claude",
      status: "unknown",
      error: null,
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      last_success_at: null,
    })));

    const result = await api().probeRelayEngine("ws-1", "claude");

    expect(result.models).toEqual([{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }]);
    expect(result.status).toBe("unknown");
  });

  it("probes the Antigravity engine and keeps its explicit absence of reasoning levels", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      engine: "antigravity",
      status: "ready",
      error: null,
      models: [{
        id: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash",
        thinking: { status: "unsupported", supported_levels: [] },
      }],
      last_success_at: "2026-10-15T06:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().probeRelayEngine("ws-1", "antigravity");

    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/antigravity/probe");
    expect(result.engine).toBe("antigravity");
    expect(result.models[0]?.thinking).toEqual({ status: "unsupported", supported_levels: [] });
  });

  it("rejects a malformed snapshot instead of reporting zero models as fact", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ engine: "claude", status: "ready", models: "none" })));

    await expect(api().probeRelayEngine("ws-1", "claude")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("preserves a Cursor runtime discovery request separately from its cached models", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      engine: "cursor",
      status: "unknown",
      models: [],
      discovery_requested: true,
      discovery_requests: [{ runtime_id: "rt-cursor", request_id: "request-1" }],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().probeRelayEngine("ws-1", "cursor");

    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/cursor/probe");
    expect(result.discovery_requested).toBe(true);
    expect(result.discovery_requests).toEqual([{ runtime_id: "rt-cursor", request_id: "request-1" }]);
    expect(result.status).toBe("unknown");
  });

  it("rejects an invalid Cursor discovery acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      engine: "cursor", status: "unknown", models: [], discovery_requested: "yes",
    })));

    await expect(api().probeRelayEngine("ws-1", "cursor")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("reads an existing discovery request and preserves a terminal failure", async () => {
    const fetch = vi.fn().mockImplementation(async () => response({
      id: "req-1", runtime_id: "rt-1", status: "failed", error: "Sign-in required",
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().getListModelsResult("rt-1", "req-1");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/runtimes/rt-1/models/req-1");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Sign-in required");
  });

  it("rejects malformed discovery results instead of treating them as completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({
      id: "req-1", runtime_id: "rt-1", status: "completed", models: "not a model list",
    })));
    await expect(api().getListModelsResult("rt-1", "req-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe("relay config endpoint", () => {
  it("rejects malformed Cursor config on reads and saves instead of returning blank settings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({
      cursor: { fragment: 42, hasToken: "yes", revision: 1 },
    })));

    await expect(api().getRelayConfig("ws-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api().updateRelayConfig("ws-1", "cursor", {
      fragment: "{}", token_op: "keep",
    })).rejects.toBeInstanceOf(ApiContractError);
  });
  it("reads the Antigravity engine and saves it through its own route", async () => {
    const config = {
      claude: null,
      codex: null,
      antigravity: { fragment: '{"base_url":"https://ai.openremi.fun/antigravity"}', hasToken: true, revision: 2 },
      modelDiscovery: true,
    };
    const fetch = vi.fn().mockImplementation(async () => response(config));
    vi.stubGlobal("fetch", fetch);

    expect((await api().getRelayConfig("ws-1")).antigravity).toEqual(config.antigravity);
    await api().updateRelayConfig("ws-1", "antigravity", { fragment: config.antigravity.fragment, token_op: "keep" });

    expect(fetch.mock.calls[1]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/antigravity");
    expect(fetch.mock.calls[1]![1].method).toBe("PUT");
  });

  it("reads an older server's config without the engine as unconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({ claude: null, codex: null, modelDiscovery: false })));

    expect((await api().getRelayConfig("ws-1")).antigravity).toBeNull();
    expect((await api().getRelayConfig("ws-1")).cursor).toBeNull();
  });

  it("reads and saves Cursor account configuration through its provider route", async () => {
    const cursor = { fragment: '{"default_model":"default"}', hasToken: true, revision: 1 };
    const fetch = vi.fn().mockImplementation(async () => response({ cursor, modelDiscovery: false }));
    vi.stubGlobal("fetch", fetch);

    expect((await api().getRelayConfig("ws-1")).cursor).toEqual(cursor);
    await api().updateRelayConfig("ws-1", "cursor", {
      fragment: cursor.fragment, token_op: "set", auth_token: "cursor-key",
    });

    expect(fetch.mock.calls[1]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/cursor");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      fragment: cursor.fragment, token_op: "set", auth_token: "cursor-key",
    });
  });
});
