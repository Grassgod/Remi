/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { issueKeys } from "../issues/queries";
import { runtimeModelsKeys } from "./models";
import { runtimeKeys } from "./queries";
import { useRetireDaemon } from "./mutations";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe("runtime mutations", () => {
  let queryClient: QueryClient;
  const retireDaemon = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    retireDaemon.mockResolvedValue({
      status: "retired",
      workspace_id: "workspace-1",
      daemon_id: "daemon-1",
      retired_at: "2026-08-16T00:00:00.000Z",
    });
    setApiInstance({ retireDaemon } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("invalidates fleet models and every Issue workspace after daemon retirement", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRetireDaemon("workspace-1"), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        daemonId: "daemon-1",
        expectedSnapshot: "snapshot-1",
      });
    });

    expect(retireDaemon).toHaveBeenCalledWith(
      "workspace-1",
      "daemon-1",
      "snapshot-1",
      false,
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: runtimeModelsKeys.fleet("workspace-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: runtimeKeys.daemonInventory("workspace-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: issueKeys.workspacesAll(),
    });
  });
});
