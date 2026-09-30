import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

afterEach(() => vi.unstubAllGlobals());
const api = () => new RuntimesEndpoints(new HttpClient("https://api.example.test"));
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("gateway context window endpoints", () => {
  it.each([false, true])("PUTs the exact boolean and parses the saved listing (enabled=%s)", async enabled => {
    const context_window = enabled ? { one_million: true, updated_by: "owner", updated_at: "2026-09-28" } : null;
    const fetch = vi.fn().mockResolvedValue(response({
      deleted: !enabled, engine: "claude", allowed_levels: [], models: [{ model_id: "claude-opus-5", context_window }],
    }));
    vi.stubGlobal("fetch", fetch);
    const result = await api().putRelayContextWindow("ws-1", "claude", { model: "claude-opus-5", one_million: enabled });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/claude/context-window");
    expect(fetch.mock.calls[0]![1].method).toBe("PUT");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ model: "claude-opus-5", one_million: enabled });
    expect(result.models[0]?.context_window).toEqual(context_window);
  });

  it("treats an absent declaration as off when reading an older server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ engine: "claude", allowed_levels: [], models: [{ model_id: "m" }] })));
    expect((await api().getRelayReasoningLevels("ws-1", "claude")).models[0]?.context_window).toBeNull();
  });

  it.each([
    {}, { deleted: false, engine: "claude", allowed_levels: [], models: [{ model_id: "m", context_window: { one_million: "true" } }] },
  ])("rejects a malformed command response: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    await expect(api().putRelayContextWindow("ws-1", "claude", { model: "m", one_million: true })).rejects.toBeInstanceOf(ApiContractError);
  });
});
