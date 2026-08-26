import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RuntimesEndpoints daemon inventory", () => {
  it("loads the manager inventory including token-only daemons", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        workspace_id: "ws/1",
        daemons: [
          {
            daemon_id: "daemon/token-only",
            runtime_count: 0,
            token_count: 1,
            last_seen: null,
            name: "Provisioning token",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(endpoints.getDaemonInventory("ws/1")).resolves.toEqual({
      workspace_id: "ws/1",
      daemons: [
        {
          daemon_id: "daemon/token-only",
          runtime_count: 0,
          token_count: 1,
          last_seen: null,
          name: "Provisioning token",
        },
      ],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/daemons?workspace_id=ws%2F1",
    );
  });

  it.each([
    { workspace_id: "ws-1", daemons: [{ daemon_id: "daemon-1" }] },
    {
      workspace_id: "ws-1",
      daemons: [
        {
          daemon_id: "daemon-1",
          runtime_count: -1,
          token_count: 1,
          last_seen: null,
          name: null,
        },
      ],
    },
    {
      workspace_id: "another-workspace",
      daemons: [],
    },
  ])("fails closed for malformed or mismatched inventory", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(endpoints.getDaemonInventory("ws-1")).resolves.toEqual({
      workspace_id: "",
      daemons: [],
    });
  });
});

describe("RuntimesEndpoints daemon retirement", () => {
  it("loads an encoded daemon retirement plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        plan: {
          workspace_id: "ws/1",
          daemon_id: "daemon/1",
          snapshot: "snapshot-1",
          already_retired: false,
          can_retire: true,
          blocking_reasons: [],
          runtimes: [],
          agents: [],
          active_tasks: [],
          queued_tasks: [{
            id: "task-1",
            status: "queued",
            agent_id: "agent-1",
            runtime_id: "runtime-1",
            issue_id: null,
          }],
          local_directory_resources: [{
            id: "resource-1",
            project_id: "project-1",
            project_title: "Project",
            label: null,
            local_path: "/private/path",
          }],
          issue_workspaces: [],
          impact: {
            runtimes_removed: 2,
            agents_detached: 0,
            queued_tasks_requeued: 1,
            session_lanes_reset: 0,
            chat_sessions_reset: 0,
            tokens_revoked: 1,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.getDaemonRetirementPlan("ws/1", "daemon/1"),
    ).resolves.toMatchObject({
      workspace_id: "ws/1",
      daemon_id: "daemon/1",
      snapshot: "snapshot-1",
      can_retire: true,
      queued_tasks: [{ issue_id: null }],
      local_directory_resources: [{ label: null }],
      runtimes: [],
      impact: { runtimes_removed: 2, agents_detached: 0 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/daemons/daemon%2F1/retirement-plan?workspace_id=ws%2F1",
    );
  });

  it("fails closed when an older or malformed server returns an invalid plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ plan: { can_retire: "yes", snapshot: 42 } }),
      ),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.getDaemonRetirementPlan("ws-1", "daemon-1"),
    ).resolves.toMatchObject({
      can_retire: false,
      snapshot: "",
      blocking_reasons: ["invalid_response"],
    });
  });

  it("fails closed when the plan belongs to another daemon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          plan: {
            workspace_id: "ws-1",
            daemon_id: "another-daemon",
            snapshot: "snapshot-1",
            already_retired: false,
            can_retire: true,
            blocking_reasons: [],
            runtimes: [],
            agents: [],
            active_tasks: [],
            queued_tasks: [],
            local_directory_resources: [],
            issue_workspaces: [],
            impact: {
              runtimes_removed: 1,
              agents_detached: 0,
              queued_tasks_requeued: 0,
              session_lanes_reset: 0,
              chat_sessions_reset: 0,
              tokens_revoked: 1,
            },
          },
        }),
      ),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.getDaemonRetirementPlan("ws-1", "daemon-1"),
    ).resolves.toMatchObject({
      can_retire: false,
      daemon_id: "",
      blocking_reasons: ["invalid_response"],
    });
  });

  it("submits the confirmed plan snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "retired",
        workspace_id: "ws-1",
        daemon_id: "daemon-1",
        retired_at: "2026-08-16T00:00:00.000Z",
        already_retired: false,
        impact: {
          runtimes_removed: 2,
          agents_detached: 1,
          queued_tasks_requeued: 1,
          session_lanes_reset: 1,
          chat_sessions_reset: 1,
          tokens_revoked: 1,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.retireDaemon("ws-1", "daemon-1", "snapshot-1"),
    ).resolves.toMatchObject({ status: "retired" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        workspace_id: "ws-1",
        expected_snapshot: "snapshot-1",
      }),
    });
  });

  it("fails closed for incomplete or mismatched retirement success responses", async () => {
    const validImpact = {
      runtimes_removed: 1,
      agents_detached: 0,
      queued_tasks_requeued: 0,
      session_lanes_reset: 0,
      chat_sessions_reset: 0,
      tokens_revoked: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(jsonResponse({ status: "retired" }))
        .mockResolvedValueOnce(jsonResponse({
          status: "retired",
          workspace_id: "ws-1",
          daemon_id: "another-daemon",
          retired_at: "2026-08-16T00:00:00.000Z",
          already_retired: false,
          impact: validImpact,
        })),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.retireDaemon("ws-1", "daemon-1", "snapshot-1"),
    ).resolves.toMatchObject({ workspace_id: "", retired_at: "" });
    await expect(
      endpoints.retireDaemon("ws-1", "daemon-1", "snapshot-1"),
    ).resolves.toMatchObject({ workspace_id: "", retired_at: "" });
  });
});

describe("RuntimesEndpoints Runtime provisions", () => {
  it("parses provision declarations and defaults version checks on older responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      provisions: [{
        id: "prov-1",
        workspace_id: "ws-1",
        kind: "npm-global",
        enabled: true,
        package: "example-tool",
        version: "latest",
        bin: "example-tool",
        command: null,
      }],
    })));
    const endpoints = new RuntimesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.listRuntimeProvisions("ws-1")).resolves.toEqual([
      expect.objectContaining({ id: "prov-1", version_check: true, args: [], trigger_kinds: [] }),
    ]);
  });

  it.each([
    null,
    { provisions: null },
    { provisions: [{ id: 42 }] },
    { provisions: [{ id: "prov-1", workspace_id: "other", kind: "future", enabled: true }] },
  ])("degrades malformed or cross-workspace provision lists to an empty list", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new RuntimesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.listRuntimeProvisions("ws-1")).resolves.toEqual([]);
  });

  it("keeps unknown state values renderable while filtering cross-provision rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      states: [
        { provision_id: "prov-1", runtime_id: "rt-1", status: "future-state" },
        { provision_id: "prov-other", runtime_id: "rt-2", status: "failed" },
      ],
    })));
    const endpoints = new RuntimesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.listRuntimeProvisionStates("ws-1", "prov-1")).resolves.toEqual([
      expect.objectContaining({ runtime_id: "rt-1", status: "future-state" }),
    ]);
  });
});

describe("RuntimesEndpoints SSH mesh", () => {
  const overview = {
    workspace_id: "ws-1",
    enabled: true,
    key_version: 2,
    fingerprint: "SHA256:test",
    rotation_state: "stable",
    config_revision: "revision-3",
    rotation_ready_daemons: 1,
    rotation_total_daemons: 1,
    created_at: "2026-08-18T00:00:00Z",
    updated_at: "2026-08-18T00:00:00Z",
    runtimes: [
      {
        daemon_id: "daemon-1",
        name: "build-host",
        status: "ready",
        ssh_user: "runner",
        ssh_alias: "remi-build-host",
        hostname: "build-host",
        addresses: ["10.37.206.133"],
      },
    ],
  };

  it("parses a browser-safe overview and defaults fields from older daemons", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(overview)));
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(endpoints.getSshMeshOverview("ws-1")).resolves.toMatchObject({
      enabled: true,
      fingerprint: "SHA256:test",
      runtimes: [
        {
          node_id: "daemon-1",
          node_type: "runtime",
          daemon_id: "daemon-1",
          ssh_alias: "remi-build-host",
          port: 22,
          peer_tests: [],
          runtime_ids: [],
        },
      ],
      nodes: [
        {
          node_id: "daemon-1",
          node_type: "runtime",
          daemon_id: "daemon-1",
          ssh_alias: "remi-build-host",
          port: 22,
          peer_tests: [],
          runtime_ids: [],
        },
      ],
      rotation_ready_nodes: 1,
      rotation_total_nodes: 1,
    });
  });

  it("prefers canonical nodes and keeps the platform separate from legacy runtimes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({
        ...overview,
        rotation_ready_nodes: 2,
        rotation_total_nodes: 2,
        nodes: [
          {
            daemon_id: "control-plane-1",
            node_id: "control-plane-1",
            node_type: "control_plane",
            name: "platform-host",
            status: "ready",
            ssh_alias: "remi-platform",
            peer_tests: [{ daemon_id: "daemon-1", status: "ready" }],
          },
          {
            ...overview.runtimes[0],
            node_id: "daemon-1",
            node_type: "runtime",
          },
        ],
      })),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    const parsed = await endpoints.getSshMeshOverview("ws-1");

    expect(parsed.rotation_ready_nodes).toBe(2);
    expect(parsed.rotation_total_nodes).toBe(2);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]).toMatchObject({
      node_id: "control-plane-1",
      node_type: "control_plane",
      runtime_ids: [],
      peer_tests: [{ node_id: "daemon-1" }],
    });
    expect(parsed.runtimes).toHaveLength(1);
    expect(parsed.runtimes[0]?.node_type).toBe("runtime");
  });

  it("strips unexpected private material before it reaches the frontend cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({
        ...overview,
        private_key: "TOP-LEVEL-SECRET",
        nodes: [{
          ...overview.runtimes[0],
          node_id: "daemon-1",
          node_type: "runtime",
          private_key: "NODE-SECRET",
          peer_tests: [{
            daemon_id: "daemon-2",
            node_id: "daemon-2",
            status: "ready",
            private_key: "PEER-SECRET",
          }],
        }],
        runtimes: [{
          ...overview.runtimes[0],
          private_key: "RUNTIME-SECRET",
          peer_tests: [{
            daemon_id: "daemon-2",
            status: "ready",
            private_key: "PEER-SECRET",
          }],
        }],
      })),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    const parsed = await endpoints.getSshMeshOverview("ws-1");

    expect(parsed).not.toHaveProperty("private_key");
    expect(parsed.nodes[0]).not.toHaveProperty("private_key");
    expect(parsed.nodes[0]?.peer_tests[0]).not.toHaveProperty("private_key");
    expect(parsed.runtimes[0]).not.toHaveProperty("private_key");
    expect(parsed.runtimes[0]?.peer_tests[0]).not.toHaveProperty("private_key");
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  it("fails closed when the server returns a null runtime list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ...overview, runtimes: null })),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(endpoints.getSshMeshOverview("ws-1")).resolves.toEqual({
      enabled: false,
      workspace_id: "",
      key_version: 0,
      fingerprint: null,
      rotation_state: "stable",
      config_revision: "",
      rotation_ready_daemons: 0,
      rotation_total_daemons: 0,
      rotation_ready_nodes: 0,
      rotation_total_nodes: 0,
      created_at: null,
      updated_at: null,
      nodes: [],
      runtimes: [],
    });
  });

  it("never sends private key material from enable, rotate, or test actions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...overview, runtimes: [] }))
      .mockResolvedValueOnce(jsonResponse({ ...overview, runtimes: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          request_id: "ssh-probe-1",
          probe_revision: 4,
          status: "pending",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await endpoints.setSshMeshEnabled("ws-1", true);
    await endpoints.rotateSshMeshKey("ws-1");
    await endpoints.testSshMeshConnection("ws-1", "daemon-1", "daemon-2");

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        source_daemon_id: "daemon-1",
        target_daemon_id: "daemon-2",
      }),
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("private_key");
  });

  it.each([
    {},
    { ...overview, enabled: false },
    { ...overview, workspace_id: "another-workspace" },
    { ...overview, rotation_state: "rolling_out" },
  ])("rejects malformed or mismatched enable responses", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.setSshMeshEnabled("ws-1", true),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("accepts the rekey-required response from an emergency disable", async () => {
    const emergencyDisabled = {
      ...overview,
      enabled: false,
      key_version: 3,
      fingerprint: null,
      rotation_state: "rekey_required",
      config_revision: "revision-4",
      runtimes: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emergencyDisabled));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.setSshMeshEnabled("ws-1", false, { invalidateKeys: true }),
    ).resolves.toMatchObject({
      enabled: false,
      key_version: 3,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ enabled: false, invalidate_keys: true }),
    });
  });

  it("rejects a stable response to an explicit emergency invalidation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({
        ...overview,
        enabled: false,
        fingerprint: null,
        rotation_state: "stable",
      })),
    );
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.setSshMeshEnabled("ws-1", false, { invalidateKeys: true }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("keeps an ordinary disable on the stable command path", async () => {
    const stableDisabled = {
      ...overview,
      enabled: false,
      rotation_state: "stable",
      runtimes: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(stableDisabled));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.setSshMeshEnabled("ws-1", false),
    ).resolves.toMatchObject({
      enabled: false,
      rotation_state: "stable",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  });

  it.each([
    {},
    { ...overview, enabled: false },
    { ...overview, workspace_id: "another-workspace" },
    { ...overview, key_version: 0, fingerprint: null },
    { ...overview, rotation_state: "unknown" },
  ])("rejects malformed or unconfirmed rotation responses", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.rotateSshMeshKey("ws-1"),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it.each([
    {},
    { request_id: "", probe_revision: 4, status: "pending" },
    { request_id: "probe-1", probe_revision: 0, status: "pending" },
    { request_id: "probe-1", probe_revision: 4, status: "done" },
  ])("rejects malformed probe acknowledgements", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new RuntimesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.testSshMeshConnection("ws-1", "daemon-1"),
    ).rejects.toBeInstanceOf(ApiContractError);
  });
});
