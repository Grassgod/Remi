import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
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
