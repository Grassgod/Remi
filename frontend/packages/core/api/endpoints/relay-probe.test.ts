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

  it("rejects a malformed snapshot instead of reporting zero models as fact", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ engine: "claude", status: "ready", models: "none" })));

    await expect(api().probeRelayEngine("ws-1", "claude")).rejects.toBeInstanceOf(ApiContractError);
  });
});
