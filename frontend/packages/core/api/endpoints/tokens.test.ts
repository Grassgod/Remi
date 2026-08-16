import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { TokensEndpoints } from "./tokens";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TokensEndpoints daemon credential provisioning", () => {
  it("requests a manager-provisioned daemon token for the exact workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      token: "mdt_daemoncredential",
      tokenId: "dtk_daemoncredential",
      workspaceId: "ws/one",
      daemonId: "daemon-one",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new TokensEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.provisionDaemonCredential({
      workspace_id: "ws/one",
      name: "Build machine",
      expires_in_days: 365,
    })).resolves.toEqual({
      token: "mdt_daemoncredential",
      tokenId: "dtk_daemoncredential",
      workspaceId: "ws/one",
      daemonId: "daemon-one",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/install/daemon",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        workspace_id: "ws/one",
        token_name: "Build machine",
        expires_in_days: 365,
        create_token: true,
      }),
    });
  });

  it.each([
    {
      token: "mul_personalcredential",
      tokenId: "pat_personalcredential",
      workspaceId: "ws-one",
      daemonId: "daemon-one",
    },
    {
      token: "mdt_daemoncredential",
      tokenId: "dtk_daemoncredential",
      workspaceId: "another-workspace",
      daemonId: "daemon-one",
    },
  ])("fails closed for a non-daemon or cross-workspace response", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const endpoints = new TokensEndpoints(new HttpClient("https://api.example.test"));

    await expect(endpoints.provisionDaemonCredential({
      workspace_id: "ws-one",
    })).resolves.toEqual({ token: "", tokenId: "", workspaceId: "", daemonId: "" });
  });
});
