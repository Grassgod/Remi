import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { AgentsEndpoints } from "./agents";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsEndpoints supervisor authority", () => {
  it("updates the dedicated supervisor endpoint with an encoded agent id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: "agent/1",
      supervisor: true,
      name: "Organizer",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new AgentsEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.setAgentSupervisor("agent/1", true)).resolves.toEqual({
      id: "agent/1",
      supervisor: true,
      name: "Organizer",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/agents/agent%2F1/supervisor",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ enabled: true });
  });

  it("keeps the requested state when an older response omits supervisor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "agent-1" })));
    const endpoints = new AgentsEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.setAgentSupervisor("agent-1", false)).resolves.toEqual({
      id: "agent-1",
      supervisor: false,
    });
  });
});
