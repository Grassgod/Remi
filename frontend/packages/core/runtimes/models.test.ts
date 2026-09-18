import { describe, expect, it, vi } from "vitest";
import { RuntimesEndpoints } from "../api/endpoints/runtimes";
import type { HttpClient } from "../api/http";
import { QueryClient } from "@tanstack/react-query";
import type { RuntimeModel } from "../types";
const listFleetModels = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { listFleetModels } }));
import { executionTargetModelsOptions, fleetModelsOptions, isFallbackModelUnavailable, isModelExecutionUnknown, isModelUnavailable, runtimeModelsKeys } from "./models";

describe("execution target model catalog", () => {
  it("requires fallback selection to be executable in the target's authoritative catalog", () => {
    const models: RuntimeModel[] = [
      { id: "ready", label: "Ready", execution_status: "available" },
      { id: "offline", label: "Offline", execution_status: "unavailable" },
    ];
    expect(isFallbackModelUnavailable("claude", "ready", models, "ready")).toBe(false);
    expect(isFallbackModelUnavailable("claude", "offline", models, "ready")).toBe(true);
    expect(isFallbackModelUnavailable("claude", "absent", models, "ready")).toBe(true);
    expect(isFallbackModelUnavailable("codex", "absent", models, "unknown")).toBe(true);
    expect(isFallbackModelUnavailable("claude", "custom", models)).toBe(false);
    expect(isFallbackModelUnavailable("claude", "", models, "ready")).toBe(false);
  });
  it("only marks absent explicit Codex models unavailable after an authoritative load", () => {
    const models = [{ id: "selectable", label: "Selectable" }];
    expect(isModelUnavailable("codex", "inventory-only", models, "ready")).toBe(true);
    expect(isModelUnavailable("codex", "selectable", models, "ready")).toBe(false);
    expect(isModelUnavailable("codex", "", models, "ready")).toBe(false);
    expect(isModelUnavailable("codex", "inventory-only", models, "error")).toBe(false);
    expect(isModelUnavailable("codex", "inventory-only", models)).toBe(false);
    expect(isModelUnavailable("claude", "inventory-only", models, "ready")).toBe(false);
  });

  it("distinguishes failed inventory from executable bundled models without restricting Claude", () => {
    const models: RuntimeModel[] = [
      { id: "gateway-only", label: "Gateway", execution_status: "unavailable" },
      { id: "bundled", label: "Bundled", execution_status: "available" },
      { id: "pending", label: "Pending", execution_status: "unknown" },
    ];
    expect(isModelUnavailable("codex", "gateway-only", models, "error")).toBe(true);
    expect(isModelUnavailable("codex", "bundled", models, "error")).toBe(false);
    expect(isModelUnavailable("codex", "custom", models, "error")).toBe(true);
    expect(isModelUnavailable("codex", "pending", models, "ready")).toBe(true);
    expect(isModelUnavailable("codex", "bundled", models, "unknown")).toBe(false);
    expect(isModelExecutionUnknown("codex", "bundled", models, "unknown")).toBe(false);
    expect(isModelUnavailable("codex", "custom-new", models, "unknown")).toBe(true);
    expect(isModelExecutionUnknown("codex", "custom-new", models, "unknown")).toBe(true);
    expect(isModelUnavailable("codex", "", models, "unknown")).toBe(false);
    expect(isModelUnavailable("claude", "gateway-only", models, "error")).toBe(false);
  });

  it.each([fleetModelsOptions("ws"), executionTargetModelsOptions("ws", "rt")])(
    "refetches unknown catalogs immediately while caching the resulting authoritative response", async (options) => {
      const pending = { providers: [{ provider: "codex", model_catalog_status: "unknown", models: [] }] };
      const ready = { providers: [{ provider: "codex", model_catalog_status: "ready", models: [{ id: "selectable", label: "Selectable" }] }] };
      listFleetModels.mockReset().mockResolvedValueOnce(pending).mockResolvedValue(ready);
      const client = new QueryClient();
      try {
        expect(await client.fetchQuery(options)).toEqual(pending);
        expect(await client.fetchQuery(options)).toEqual(ready);
        expect(await client.fetchQuery(options)).toEqual(ready);
        expect(listFleetModels).toHaveBeenCalledTimes(2);
      } finally {
        client.clear();
      }
    },
  );

  it("isolates group models by workspace, group and agent owner context", () => {
    const first = executionTargetModelsOptions("ws", null, "team", "agent-a");
    expect(first.enabled).toBe(true);
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws", null, "team", "agent-b").queryKey);
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws", null, "other", "agent-a").queryKey);
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("other-ws", null, "team", "agent-a").queryKey);
  });

  it("sends a stable group identifier and validates group membership responses", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ providers: [] })
      .mockResolvedValueOnce({ groups: [{ id: "team", workspace_id: "ws", name: "team", provider: "codex", runtime_ids: "bad", online_runtime_count: 1 }] });
    const endpoints = new RuntimesEndpoints({ fetch } as unknown as HttpClient);
    await endpoints.listFleetModels({ workspace_id: "ws", execution_group_id: "team", agent_id: "a" });
    expect(fetch).toHaveBeenCalledWith("/api/models?workspace_id=ws&execution_group_id=team&agent_id=a");
    await expect(endpoints.listExecutionGroups({ workspace_id: "ws", agent_id: "a" })).rejects.toThrow();
  });

  it("isolates target caches and loads the workspace catalog for automatic scheduling", () => {
    const first = executionTargetModelsOptions("ws-a", "rt-a");
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws-b", "rt-a").queryKey);
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws-a", "rt-b").queryKey);
    expect(first.queryKey.slice(0, 4)).toEqual(runtimeModelsKeys.fleet("ws-a"));
    expect(executionTargetModelsOptions("ws-a", null).enabled).toBe(true);
    expect(executionTargetModelsOptions("ws-a", null).queryKey).not.toEqual(first.queryKey);
    expect(executionTargetModelsOptions("", "rt-a").enabled).toBe(false);
  });

  it.each([
    { id: 12 },
    { id: "model", thinking: { supported_levels: "high" } },
  ])("sends the target and rejects malformed model capabilities: %j", async (model) => {
    const fetch = vi.fn().mockResolvedValue({ providers: [{ provider: "codex", models: [model] }] });
    const endpoints = new RuntimesEndpoints({ fetch } as unknown as HttpClient);
    const response = await endpoints.listFleetModels({ workspace_id: "ws-a", runtime_id: "rt/a" });
    expect(fetch).toHaveBeenCalledWith("/api/models?workspace_id=ws-a&runtime_id=rt%2Fa");
    expect(response).toEqual({ providers: [] });
  });
});
