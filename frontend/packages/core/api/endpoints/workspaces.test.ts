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

describe("WorkspacesEndpoints bot menu", () => {
  it("updates and dry-runs a bot menu through encoded workspace paths", async () => {
    const menu = { default: [{ name: "Status", behaviors: [{ type: "send_message" as const }] }] };
    const responses = [
      { workspace_id: "ws/1", bot_menu: menu },
      {
        id: "bmp_1",
        workspace_id: "ws/1",
        dry_run: true,
        status: "pending",
        result: null,
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(responses[0]))
      .mockResolvedValueOnce(jsonResponse(responses[1]));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.updateBotMenu("ws/1", menu)).resolves.toEqual(responses[0]);
    await expect(endpoints.publishBotMenu("ws/1", true)).resolves.toEqual(responses[1]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/workspaces/ws%2F1/bot-menu");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example.test/api/workspaces/ws%2F1/bot-menu/publish");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ dry_run: true });
  });

  it("fails closed to an unusable response when publish status is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: null, status: "done" })));
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getBotMenuPublish("ws-1", "request-1")).resolves.toMatchObject({
      id: "",
      status: "failed",
      error: "Invalid server response",
    });
  });
});
