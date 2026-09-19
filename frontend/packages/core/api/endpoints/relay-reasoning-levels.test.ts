import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const api = () => new RuntimesEndpoints(new HttpClient("https://api.example.test"));

afterEach(() => vi.unstubAllGlobals());

describe("relay reasoning-levels endpoints", () => {
  it("keeps manual and effective declarations from the snapshot listing", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      engine: "claude",
      allowed_levels: ["low", "medium", "high", "xhigh", "max"],
      models: [
        {
          model_id: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          manual: {
            levels: ["low", "high"],
            default_level: "high",
            updated_by: "owner@example.test",
            updated_at: "2026-09-19T08:00:00.000Z",
          },
          effective: {
            supported_levels: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
            default_level: "high",
            status: "supported",
            source: "manual",
          },
        },
        { model_id: "deepseek-flash", label: "DeepSeek Flash", manual: null, effective: null },
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().getRelayReasoningLevels("ws-1", "claude");

    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/claude/reasoning-levels");
    expect(fetch.mock.calls[0]![1].method).toBeUndefined();
    expect(result.allowed_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(result.models[0]?.manual?.levels).toEqual(["low", "high"]);
    expect(result.models[0]?.effective?.source).toBe("manual");
    expect(result.models[1]?.manual).toBeNull();
    expect(result.models[1]?.effective).toBeNull();
  });

  it("PUTs a declaration and keeps the saved manual levels", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      levels: ["low", "high"],
      default_level: "high",
      updated_by: "owner@example.test",
      updated_at: "2026-09-19T08:10:00.000Z",
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().putRelayReasoningLevel("ws-1", "claude", {
      model: "deepseek-v4-flash",
      levels: ["low", "high"],
      default_level: "high",
    });

    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws-1/relay-config/claude/reasoning-levels");
    expect(fetch.mock.calls[0]![1].method).toBe("PUT");
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      model: "deepseek-v4-flash",
      levels: ["low", "high"],
      default_level: "high",
    });
    expect(result).toEqual({
      levels: ["low", "high"],
      default_level: "high",
      updated_by: "owner@example.test",
      updated_at: "2026-09-19T08:10:00.000Z",
    });
  });

  it("clears a declaration with levels: [] and accepts the deleted answer", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ deleted: true }));
    vi.stubGlobal("fetch", fetch);

    const result = await api().putRelayReasoningLevel("ws-1", "codex", { model: "gpt-6-luna", levels: [] });

    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ model: "gpt-6-luna", levels: [] });
    expect(result).toEqual({ deleted: true });
  });

  it("omits default_level when the caller has none", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ deleted: true }));
    vi.stubGlobal("fetch", fetch);

    await api().putRelayReasoningLevel("ws-1", "claude", { model: "deepseek-v4-flash", levels: [] });

    expect(Object.keys(JSON.parse(fetch.mock.calls[0]![1].body as string))).toEqual(["model", "levels"]);
  });

  it("rejects a malformed listing instead of rendering every model as undeclared", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      engine: "claude",
      allowed_levels: ["low", "high"],
      models: "none",
    })));

    await expect(api().getRelayReasoningLevels("ws-1", "claude")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects a response that drops required level data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      engine: "claude",
      models: [],
    })));

    await expect(api().getRelayReasoningLevels("ws-1", "claude")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects an unknown effective source instead of mislabelling the origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      engine: "claude",
      allowed_levels: ["low", "high"],
      models: [{
        model_id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        manual: null,
        effective: {
          supported_levels: [{ value: "low", label: "low" }],
          status: "supported",
          source: "teammate",
        },
      }],
    })));

    await expect(api().getRelayReasoningLevels("ws-1", "claude")).rejects.toBeInstanceOf(ApiContractError);
  });
});
