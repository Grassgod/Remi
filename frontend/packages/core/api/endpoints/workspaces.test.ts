import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
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
  it("loads the AGENTS.md and turn input templates from an encoded workspace path", async () => {
    const body = {
      instructions: "# Remi notes\n\n{{issue_title}}",
      input: "{{current_request}}",
      sha256: { instructions: "a".repeat(64), input: "b".repeat(64) },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptTemplate("ws/1")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/workspaces/ws%2F1/prompt-template",
    );
  });

  it.each([
    { instructions: null },
    { bootstrap: "# Bootstrap Prompt", delta: "# Delta Prompt", sha256: { bootstrap: "a".repeat(64), delta: "b".repeat(64) } },
  ])("fails closed when the template response is malformed or from before ADR 0023", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptTemplate("ws-1")).resolves.toEqual(
      EMPTY_PLATFORM_PROMPT_TEMPLATE,
    );
  });
});

describe("WorkspacesEndpoints workspace prompt", () => {
  const settings = { prompt: "Workspace rule", revision: 3, updatedAt: "2026-10-18T00:00:00.000Z", updatedBy: "user-1" };

  it("reads and saves the one workspace prompt with the expected revision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...settings, revision: 2, prompt: "" }))
      .mockResolvedValueOnce(jsonResponse(settings));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptSettings("ws/1")).resolves.toEqual({ ...settings, revision: 2, prompt: "" });
    await expect(endpoints.updateWorkspacePromptSettings("ws/1", { prompt: "Workspace rule", expected_revision: 2 }))
      .resolves.toEqual(settings);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/workspaces/ws%2F1/prompts");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ prompt: "Workspace rule", expected_revision: 2 });
  });

  it("rejects a prompt response it cannot read instead of editing an empty prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ bootstrapPrompt: "Old", deltaPrompt: "", revision: 1 })));
    const endpoints = new WorkspacesEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.getWorkspacePromptSettings("ws-1")).rejects.toBeInstanceOf(ApiContractError);
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
