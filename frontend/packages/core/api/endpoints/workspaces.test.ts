import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { EMPTY_PLATFORM_PROMPT_TEMPLATE } from "../schemas/workspaces";
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
