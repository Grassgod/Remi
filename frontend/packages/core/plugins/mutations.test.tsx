/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  useActivateAgentPluginVersion,
  useCreateAgentPluginVersion,
  useInspectAgentPluginRepository,
  useRetryAgentPluginRuntime,
  useRollbackAgentPluginVersion,
} from "./mutations";
import { agentPluginKeys } from "./queries";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe("agent plugin version mutations", () => {
  let queryClient: QueryClient;
  const createAgentPluginVersion = vi.fn();
  const activateAgentPluginVersion = vi.fn();
  const rollbackAgentPluginVersion = vi.fn();
  const retryAgentPluginRuntime = vi.fn();
  const inspectAgentPluginRepository = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    createAgentPluginVersion.mockResolvedValue(null);
    activateAgentPluginVersion.mockResolvedValue(null);
    rollbackAgentPluginVersion.mockResolvedValue(null);
    retryAgentPluginRuntime.mockResolvedValue([]);
    inspectAgentPluginRepository.mockResolvedValue(null);
    setApiInstance({
      createAgentPluginVersion,
      activateAgentPluginVersion,
      rollbackAgentPluginVersion,
      retryAgentPluginRuntime,
      inspectAgentPluginRepository,
    } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("forwards version operations and invalidates the workspace plugin tree", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = createWrapper(queryClient);
    const create = renderHook(
      () => useCreateAgentPluginVersion("workspace-1", "plugin-1"),
      { wrapper },
    );
    const activate = renderHook(
      () => useActivateAgentPluginVersion("workspace-1", "plugin-1"),
      { wrapper },
    );
    const rollback = renderHook(
      () => useRollbackAgentPluginVersion("workspace-1", "plugin-1"),
      { wrapper },
    );
    const retry = renderHook(
      () => useRetryAgentPluginRuntime("workspace-1", "plugin-1"),
      { wrapper },
    );
    const createInput = { manifest: { name: "review-tools" } };

    await act(async () => {
      await create.result.current.mutateAsync(createInput);
      await activate.result.current.mutateAsync("version-2");
      await rollback.result.current.mutateAsync("version-1");
      await retry.result.current.mutateAsync({
        runtimeId: "runtime-1",
        versionId: "version-2",
      });
    });

    expect(createAgentPluginVersion).toHaveBeenCalledWith(
      "plugin-1",
      createInput,
    );
    expect(activateAgentPluginVersion).toHaveBeenCalledWith(
      "plugin-1",
      "version-2",
    );
    expect(rollbackAgentPluginVersion).toHaveBeenCalledWith(
      "plugin-1",
      "version-1",
    );
    expect(retryAgentPluginRuntime).toHaveBeenCalledWith(
      "plugin-1",
      "runtime-1",
      "version-2",
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(4);
    for (const [filters] of invalidateQueries.mock.calls) {
      expect(filters).toEqual({
        queryKey: agentPluginKeys.all("workspace-1"),
      });
    }
  });

  it("adds the workspace boundary when inspecting a repository", async () => {
    const wrapper = createWrapper(queryClient);
    const inspect = renderHook(
      () => useInspectAgentPluginRepository("workspace-1"),
      { wrapper },
    );

    await act(async () => {
      await inspect.result.current.mutateAsync({
        sourceUrl: "https://example.test/plugins.git",
        sourceRef: "main",
      });
    });

    expect(inspectAgentPluginRepository).toHaveBeenCalledWith({
      sourceUrl: "https://example.test/plugins.git",
      sourceRef: "main",
      workspaceId: "workspace-1",
      workspace_id: "workspace-1",
    });
  });
});
