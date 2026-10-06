// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usageKeys, usageReportOptions, useSetUsagePrice } from "./queries";
import { ApiClient, setApiInstance } from "../api";
import type { SetUsagePriceInput, UsagePrice } from "@multiremi/contracts/usage-accounting";

afterEach(() => vi.restoreAllMocks());
describe("Usage queries", () => {
  it("partitions reports by workspace, project, runtime, history and timezone", () => {
    const base = { days: 30, tz: "UTC", project_id: null, runtime_id: null };
    const key = usageKeys.report("ws", base);
    for (const params of [{ ...base, days: "all" as const }, { ...base, tz: "Asia/Shanghai" }, { ...base, project_id: "project" }, { ...base, runtime_id: "runtime" }]) expect(usageKeys.report("ws", params)).not.toEqual(key);
    expect(usageKeys.report("other", base)).not.toEqual(key);
    expect(usageReportOptions("ws", base).refetchInterval).toBe(60_000);
  });
  it("refreshes every view in the workspace only after a price version is saved", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
    const price: SetUsagePriceInput = { provider: "codex", model: "m", connection_id: null, requested_model_alias: false, currency: "USD",
      input_per_million: 0, output_per_million: null, cache_read_per_million: null, cache_write_per_million: null, unsplit_per_million: null,
      source: "configured", source_url: null, effective_from: "2026-10-01T00:00:00.000Z", effective_to: null };
    const client = new ApiClient("http://localhost");
    setApiInstance(client);
    const save = vi.spyOn(client, "setUsagePrice").mockRejectedValueOnce(new Error("save failed")).mockResolvedValueOnce({ ...price, id: "p", workspace_id: "ws", created_at: "now" } as UsagePrice);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSetUsagePrice("ws"), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(price)).rejects.toThrow(); });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => { await result.current.mutateAsync(price); });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["usage-accounting", "ws"] }));
    expect(save).toHaveBeenCalledWith("ws", price);
    qc.clear();
  });
});
