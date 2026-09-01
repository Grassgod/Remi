import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http";
import { FeishuEndpoints } from "./feishu";

function endpoints(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  const http = { fetch: fetchMock } as unknown as HttpClient;
  return { api: new FeishuEndpoints(http), fetchMock };
}

describe("FeishuEndpoints message connection authorization", () => {
  it("provisions through the generic messaging API without putting credentials in the URL", async () => {
    const { api, fetchMock } = endpoints({
      connection: { id: "mconn_1", name: "Work Feishu", status: "unauthenticated" },
    });

    await expect(api.createFeishuMessageConnection("ws/one", {
      name: "Work Feishu",
      appId: "cli_app",
      appSecret: "app-secret",
    })).resolves.toMatchObject({ id: "mconn_1", status: "unauthenticated" });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/workspaces/ws%2Fone/messaging/connections");
    expect(path).not.toContain("app-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "lark_cli",
      channel: "feishu",
      name: "Work Feishu",
      configuration: { appId: "cli_app", appSecret: "app-secret" },
    });
  });

  it("reads only the public authorization session", async () => {
    const { api, fetchMock } = endpoints({
      authorization: {
        id: "auth_1",
        status: "pending",
        verificationUrl: "https://open.feishu.cn/device",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-09-01T00:10:00.000Z",
        errorCode: null,
        deviceCode: "must-be-dropped",
      },
      connection: { id: "mconn_1", name: "Work Feishu", status: "unauthenticated" },
    });

    const result = await api.getFeishuMessageAuthorization("ws_1", "mconn_1", "auth_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws_1/messaging/connections/mconn_1/authorization-sessions/auth_1",
    );
    expect(result.authorization).not.toHaveProperty("deviceCode");
    expect(result.authorization.verificationUrl).toBe("https://open.feishu.cn/device");
  });

  it("rejects a malformed authorization state instead of polling forever", async () => {
    const { api } = endpoints({
      authorization: { id: "auth_1", status: "some-new-state" },
      connection: { id: "mconn_1" },
    });

    await expect(api.beginFeishuMessageAuthorization("ws_1", "mconn_1")).rejects.toThrow();
  });
});
