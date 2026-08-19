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
import type { SshMeshOverview, SshMeshRuntime } from "./types";
import { useRetireDaemon, useTestSshMeshConnection } from "./mutations";

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
  const testSshMeshConnection = vi.fn();

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
    testSshMeshConnection.mockResolvedValue({
      request_id: "probe-1",
      probe_revision: 4,
      status: "pending",
    });
    setApiInstance({ retireDaemon, testSshMeshConnection } as unknown as ApiClient);
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

  it("marks a platform node as probing without mutating the legacy runtime list", async () => {
    const platformNode = meshNode("control-plane-1", "control_plane");
    const runtimeNode = meshNode("daemon-1", "runtime");
    const overview: SshMeshOverview = {
      workspace_id: "workspace-1",
      enabled: true,
      key_version: 2,
      fingerprint: "SHA256:test",
      rotation_state: "stable",
      config_revision: "revision-3",
      rotation_ready_daemons: 1,
      rotation_total_daemons: 1,
      rotation_ready_nodes: 2,
      rotation_total_nodes: 2,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
      nodes: [platformNode, runtimeNode],
      runtimes: [runtimeNode],
    };
    queryClient.setQueryData(runtimeKeys.sshMesh("workspace-1"), overview);
    const { result } = renderHook(
      () => useTestSshMeshConnection("workspace-1"),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({
        sourceDaemonId: "control-plane-1",
        targetDaemonId: "daemon-1",
      });
    });

    expect(testSshMeshConnection).toHaveBeenCalledWith(
      "workspace-1",
      "control-plane-1",
      "daemon-1",
    );
    const cached = queryClient.getQueryData<SshMeshOverview>(
      runtimeKeys.sshMesh("workspace-1"),
    );
    expect(cached?.nodes[0]?.desired_probe_revision).toBe(4);
    expect(cached?.runtimes[0]?.desired_probe_revision).toBe(3);
  });
});

function meshNode(
  nodeId: string,
  nodeType: SshMeshRuntime["node_type"],
): SshMeshRuntime {
  return {
    node_id: nodeId,
    node_type: nodeType,
    daemon_id: nodeId,
    runtime_ids: [],
    name: nodeId,
    status: "ready",
    protocol_version: 1,
    key_version: 2,
    config_revision: "revision-3",
    desired_config_revision: "revision-3",
    ssh_user: "runner",
    ssh_alias: `remi-${nodeId}`,
    hostname: nodeId,
    port: 22,
    addresses: ["10.0.0.1"],
    host_keys: ["ssh-ed25519 test"],
    public_key_installed: true,
    config_installed: true,
    last_error_code: null,
    last_error: null,
    last_reported_at: "2026-08-18T00:00:00.000Z",
    probe_revision: 3,
    desired_probe_revision: 3,
    peer_tests: [],
  };
}
