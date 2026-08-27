import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import {
  EMPTY_PLATFORM_PROMPT_TEMPLATE,
} from "../schemas/workspaces";
import { WorkspacesEndpoints } from "./workspaces";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspacesEndpoints prompt template", () => {
  it("loads the platform template from an encoded workspace path", async () => {
    const body = {
      bootstrap: "# Bootstrap Prompt",
      delta: "# Delta Prompt",
      sha256: { bootstrap: "a".repeat(64), delta: "b".repeat(64) },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptTemplate("ws/1")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/workspaces/ws%2F1/prompt-template",
    );
  });

  it("fails closed when the template response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ bootstrap: null })));
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptTemplate("ws-1")).resolves.toEqual(
      EMPTY_PLATFORM_PROMPT_TEMPLATE,
    );
  });
});

describe("WorkspacesEndpoints Organizer settings", () => {
  it("loads and updates the dedicated Organizer endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ workspace_id: "ws/1", mode: "report_only" }))
      .mockResolvedValueOnce(jsonResponse({ workspace_id: "ws/1", mode: "act" }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspaceOrganizerSettings("ws/1")).resolves.toEqual({
      workspace_id: "ws/1",
      mode: "report_only",
    });
    await expect(endpoints.updateWorkspaceOrganizerSettings("ws/1", "act")).resolves.toEqual({
      workspace_id: "ws/1",
      mode: "act",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/workspaces/ws%2F1/organizer",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ mode: "act" });
  });

  it("fails closed to report-only when the response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ mode: "unknown" })));
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspaceOrganizerSettings("ws-1")).resolves.toEqual({
      workspace_id: "ws-1",
      mode: "report_only",
    });
  });
});
