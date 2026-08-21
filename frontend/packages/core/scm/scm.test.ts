/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

const connection = {
  id: "scm_1",
  workspaceId: "ws_1",
  name: "GitHub",
  provider: "github",
  mode: "hybrid",
  baseUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  enabled: true,
  pollIntervalSeconds: 60,
  accessTokenSet: true,
  accessTokenHint: "ghp_…abcd",
  webhookSecretSet: true,
  webhookSecretHint: "••••abcd",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  repositories: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("SCM API", () => {
  it("parses provider capability differences used by the automation editor", async () => {
    const stream = {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      providers: {
        github: {
          provider: "github",
          streams: {
            default_branch: stream,
            change_requests: stream,
            comments: stream,
            reviews: stream,
            pipelines: stream,
          },
          supportsDeleteTombstones: false,
          supportsConditionalRequests: true,
        },
        codebase: {
          provider: "codebase",
          streams: {
            default_branch: stream,
            change_requests: stream,
            comments: stream,
            reviews: stream,
            pipelines: { ...stream, webhook: false, webhookFidelity: null },
          },
          supportsDeleteTombstones: false,
          supportsConditionalRequests: false,
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const client = new ApiClient("https://multiremi.example");
    const result = await client.getScmCapabilities();

    expect(result?.providers.codebase.streams.pipelines.webhook).toBe(false);
    expect(result?.providers.github.streams.pipelines.webhook).toBe(true);
  });

  it("parses masked connections without requiring secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ connections: [connection] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const client = new ApiClient("https://multiremi.example");
    const result = await client.listScmConnections("ws_1");

    expect(result.connections[0]).toMatchObject({
      id: "scm_1",
      accessTokenSet: true,
      accessTokenHint: "ghp_…abcd",
    });
    expect(result.connections[0]).not.toHaveProperty("accessToken");
  });

  it("sends connection secrets only in the mutation body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ connection }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("https://multiremi.example");
    await client.createScmConnection("ws_1", {
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "secret-token",
      repositoryIds: ["repo_1"],
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://multiremi.example/api/workspaces/ws_1/scm/connections",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "secret-token",
      repositoryIds: ["repo_1"],
    });
  });

  it("parses the canonical event contract shared by poll and webhook", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{
        id: "evt_1",
        workspaceId: "ws_1",
        connectionId: "scm_1",
        repositoryId: "repo_1",
        provider: "github",
        type: "change.merged",
        subjectType: "change_request",
        subjectId: "42",
        logicalKey: "repo_1:change.merged:42:abc",
        primarySource: "webhook",
        fidelity: "exact",
        occurredAt: null,
        observedAt: "2026-08-21T00:00:00.000Z",
        payload: {},
        status: "processed",
        attemptCount: 1,
        availableAt: "2026-08-21T00:00:00.000Z",
        leaseUntil: null,
        lastError: null,
        processedAt: "2026-08-21T00:00:01.000Z",
        createdAt: "2026-08-21T00:00:00.000Z",
      }],
      total: 1,
      nextAfter: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const client = new ApiClient("https://multiremi.example");
    const result = await client.listScmEvents("ws_1");

    expect(result.events[0]).toMatchObject({
      type: "change.merged",
      primarySource: "webhook",
      logicalKey: "repo_1:change.merged:42:abc",
    });
    expect(result.total).toBe(1);
  });
});
