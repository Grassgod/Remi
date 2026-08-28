import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { IssuesEndpoints } from "./issues";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const workspace = {
  issue_id: "issue-1",
  workspace_id: "ws-1",
  issue_key: "MUL-1",
  runtime_id: "runtime-1",
  runtime_name: "claude (legacy-host)",
  runtime_status: "online",
  root_path: "/tmp/MUL-1",
  branch_name: "agent/MUL-1",
  status: "ready",
  repos: [],
  last_task_id: null,
  cleaned_at: null,
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssuesEndpoints issue workspace response schema", () => {
  it("defaults machine metadata from an older server to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ workspace })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({
      workspace: {
        ...workspace,
        runtime_provider: null,
        runtime_mode: null,
        runtime_device_info: null,
        runtime_daemon_id: null,
        runtime_machine_name: null,
      },
    });
  });

  it("falls back without throwing when machine metadata is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      workspace: { ...workspace, runtime_machine_name: 42 },
    })));
    const endpoints = new IssuesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getIssueWorkspace("issue-1")).resolves.toEqual({ workspace: null });
  });
});
