// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { executionTargetModelsOptions, runtimeModelsKeys } from "./models";

const listFleetModels = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { listFleetModels } }));

afterEach(() => vi.useRealTimers());

describe("pending model catalog recovery", () => {
  it("bounds pending recovery requests and still accepts a later capability invalidation", async () => {
    vi.useFakeTimers();
    listFleetModels.mockReset().mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "unknown", models: [] }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, executionTargetModelsOptions("ws", "rt"));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      const pendingCalls = listFleetModels.mock.calls.length;
      expect(pendingCalls).toBeGreaterThan(1);
      expect(pendingCalls).toBeLessThanOrEqual(15);
      expect(observer.getCurrentResult().data?.providers[0]?.model_catalog_status).toBe("unknown");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listFleetModels).toHaveBeenCalledTimes(pendingCalls);

      listFleetModels.mockResolvedValue({ providers: [{ provider: "codex", model_catalog_status: "ready", models: [{ id: "ready-model", label: "Ready model", execution_status: "available" }] }] });
      await client.invalidateQueries({ queryKey: runtimeModelsKeys.fleet("ws") });
      expect(observer.getCurrentResult().data?.providers[0]?.models[0]?.id).toBe("ready-model");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listFleetModels).toHaveBeenCalledTimes(pendingCalls + 1);

      // A later gateway refresh gets its own bounded recovery window.
      listFleetModels.mockResolvedValueOnce({ providers: [{ provider: "codex", model_catalog_status: "unknown", models: [] }] });
      await client.invalidateQueries({ queryKey: runtimeModelsKeys.fleet("ws") });
      expect(observer.getCurrentResult().data?.providers[0]?.model_catalog_status).toBe("unknown");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observer.getCurrentResult().data?.providers[0]?.model_catalog_status).toBe("ready");
      expect(listFleetModels).toHaveBeenCalledTimes(pendingCalls + 3);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
