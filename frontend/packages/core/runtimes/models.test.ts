import { describe, expect, it, vi } from "vitest";
import { RuntimesEndpoints } from "../api/endpoints/runtimes";
import type { HttpClient } from "../api/http";
import { executionTargetModelsOptions, runtimeModelsKeys } from "./models";

describe("execution target model catalog", () => {
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

  it("isolates target caches by workspace and runtime and waits for a selection", () => {
    const first = executionTargetModelsOptions("ws-a", "rt-a");
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws-b", "rt-a").queryKey);
    expect(first.queryKey).not.toEqual(executionTargetModelsOptions("ws-a", "rt-b").queryKey);
    expect(first.queryKey.slice(0, 4)).toEqual(runtimeModelsKeys.fleet("ws-a"));
    expect(executionTargetModelsOptions("ws-a", null).enabled).toBe(false);
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
