import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { EMPTY_WORKSPACE_SESSION_ARCHIVE_STATUS } from "../schemas/session-archives";
import { SessionArchivesEndpoints } from "./session-archives";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const statusResponse = {
  config: {
    backend: "local",
    root_hint: "~/.remi/multiremi/session-archives",
    require_archive: true,
    max_bytes: 2_147_483_648,
    min_free_bytes: 10_737_418_240,
    workspace_ttl_ms: 259_200_000,
    gc_interval_ms: 900_000,
  },
  usage: {
    total_archives: 3,
    ready_archives: 2,
    failed_archives: 1,
    pending_archives: 0,
    exhausted_archives: 1,
    total_bytes: 1_024,
  },
  last_failure: {
    archive_id: "archive-failed",
    issue_id: "iss_internal",
    issue_key: "MUL-55",
    error: "archive upload failed",
    updated_at: "2026-08-19T00:01:00.000Z",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionArchivesEndpoints", () => {
  it("loads and updates the controlled workspace archive configuration", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse))
      .mockResolvedValueOnce(jsonResponse({
        ...statusResponse,
        config: { ...statusResponse.config, workspace_ttl_ms: 86_400_000 },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new SessionArchivesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.getWorkspaceSessionArchiveConfig("ws/1"),
    ).resolves.toMatchObject({
      config: { backend: "local", workspace_ttl_ms: 259_200_000 },
      usage: { total_archives: 3 },
      last_failure: { issue_id: "iss_internal", issue_key: "MUL-55" },
    });
    await expect(
      endpoints.updateWorkspaceSessionArchiveConfig("ws/1", {
        workspace_ttl_ms: 86_400_000,
        gc_interval_ms: 900_000,
      }),
    ).resolves.toMatchObject({ config: { workspace_ttl_ms: 86_400_000 } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/workspaces/ws%2F1/session-archive",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        workspace_ttl_ms: 86_400_000,
        gc_interval_ms: 900_000,
      }),
    });
  });

  it("degrades a malformed status response without crashing settings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ config: null })));
    const endpoints = new SessionArchivesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.getWorkspaceSessionArchiveConfig("ws-1"),
    ).resolves.toEqual(EMPTY_WORKSPACE_SESSION_ARCHIVE_STATUS);
  });

  it("rejects malformed mutation responses instead of reporting a false success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ saved: true })));
    const endpoints = new SessionArchivesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.updateWorkspaceSessionArchiveConfig("ws-1", {
        workspace_ttl_ms: 3_600_000,
        gc_interval_ms: 60_000,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects malformed archive lists instead of reporting a false empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ archives: null })));
    const endpoints = new SessionArchivesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.listIssueSessionArchives("issue-1"),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("lists, verifies, and retries issue archives through encoded paths", async () => {
    const archive = {
      id: "arc/1",
      workspace_id: "ws-1",
      issue_id: "MUL/55",
      runtime_id: "runtime-1",
      daemon_id: "daemon-1",
      source_revision: "rev-1",
      sha256: "abc",
      size_bytes: 10,
      uploaded_size_bytes: 10,
      file_count: 1,
      status: "ready",
      relative_path: "ws/issue/archive.tar.zst",
      metadata: {},
      attempt_count: 1,
      last_error: null,
      next_retry_at: null,
      retry_exhausted_at: null,
      retry_state: "future-server-state",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:01:00.000Z",
      completed_at: "2026-08-19T00:01:00.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ archives: [archive], latest: archive, latest_ready: archive }))
      .mockResolvedValueOnce(jsonResponse({ archive, valid: true, actual_sha256: "abc", actual_size_bytes: 10, error: null }))
      .mockResolvedValueOnce(jsonResponse({ archive: { ...archive, status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new SessionArchivesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    const listed = await endpoints.listIssueSessionArchives("MUL/55");
    await endpoints.verifyIssueSessionArchive("MUL/55", "arc/1");
    await endpoints.retryIssueSessionArchive("MUL/55", "arc/1");

    expect(listed.archives[0]?.retry_state).toBe("eligible");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.example.test/api/issues/MUL%2F55/session-archives",
      "https://api.example.test/api/issues/MUL%2F55/session-archives/arc%2F1/verify",
      "https://api.example.test/api/issues/MUL%2F55/session-archives/arc%2F1/retry",
    ]);
  });
});
