import { describe, expect, it } from "vitest";
import type { SshMeshOverview } from "./types";
import {
  getSshMeshRefreshInterval,
  RUNTIME_HEARTBEAT_REFRESH_MIN_INTERVAL_MS,
  RUNTIME_LIST_REFRESH_MS,
  runtimeListOptions,
  shouldRefreshOnHeartbeat,
  SSH_MESH_ACTIVE_REFRESH_MS,
  SSH_MESH_IDLE_REFRESH_MS,
} from "./queries";

describe("runtime list refresh", () => {
  it("uses a 30-second visible-page refresh interval", () => {
    expect(RUNTIME_LIST_REFRESH_MS).toBe(30_000);
    expect(runtimeListOptions("ws-1")).toMatchObject({
      staleTime: 10_000,
      refetchInterval: RUNTIME_LIST_REFRESH_MS,
      refetchIntervalInBackground: false,
    });
  });

  it("throttles heartbeat-triggered refreshes", () => {
    expect(RUNTIME_HEARTBEAT_REFRESH_MIN_INTERVAL_MS).toBe(15_000);
    expect(shouldRefreshOnHeartbeat(null, 100_000)).toBe(true);
    expect(shouldRefreshOnHeartbeat(100_000, 114_999)).toBe(false);
    expect(shouldRefreshOnHeartbeat(100_000, 115_000)).toBe(true);
    expect(shouldRefreshOnHeartbeat(100_000, 101_000, 1_000)).toBe(true);
  });
});

function overview(
  overrides: Partial<SshMeshOverview> = {},
): SshMeshOverview {
  return {
    workspace_id: "ws-1",
    enabled: true,
    key_version: 2,
    fingerprint: "SHA256:test",
    rotation_state: "stable",
    config_revision: "revision-3",
    rotation_ready_daemons: 1,
    rotation_total_daemons: 1,
    rotation_ready_nodes: 1,
    rotation_total_nodes: 1,
    created_at: "2026-08-18T00:00:00Z",
    updated_at: "2026-08-18T00:00:00Z",
    nodes: [],
    runtimes: [],
    ...overrides,
  };
}

describe("getSshMeshRefreshInterval", () => {
  it("keeps a slow fallback refresh after the mesh reaches a stable state", () => {
    expect(getSshMeshRefreshInterval(overview())).toBe(
      SSH_MESH_IDLE_REFRESH_MS,
    );
    expect(getSshMeshRefreshInterval(undefined)).toBe(
      SSH_MESH_IDLE_REFRESH_MS,
    );
  });

  it("refreshes quickly while key rotation is rolling out", () => {
    expect(
      getSshMeshRefreshInterval(overview({ rotation_state: "rolling_out" })),
    ).toBe(SSH_MESH_ACTIVE_REFRESH_MS);
  });

  it.each([
    { status: "syncing", probe_revision: 3, desired_probe_revision: 3 },
    { status: "ready", probe_revision: 3, desired_probe_revision: 4 },
  ])("refreshes quickly while a daemon is applying state", (runtimeState) => {
    expect(
      getSshMeshRefreshInterval(
        overview({
          nodes: [
            {
              node_id: "daemon-1",
              node_type: "runtime",
              daemon_id: "daemon-1",
              runtime_ids: [],
              name: "build-host",
              protocol_version: 1,
              key_version: 2,
              config_revision: "revision-3",
              desired_config_revision: "revision-3",
              ssh_user: "runner",
              ssh_alias: "remi-build-host",
              hostname: "build-host",
              port: 22,
              addresses: ["10.0.0.1"],
              host_keys: ["SHA256:host"],
              public_key_installed: true,
              config_installed: true,
              last_error_code: null,
              last_error: null,
              last_reported_at: "2026-08-18T00:00:00Z",
              peer_tests: [],
              ...runtimeState,
            },
          ],
        }),
      ),
    ).toBe(SSH_MESH_ACTIVE_REFRESH_MS);
  });
});
