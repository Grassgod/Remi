import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http";
import { FeishuBotEndpoints } from "./feishu-bot";

function endpoints(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  const http = { fetch: fetchMock } as unknown as HttpClient;
  return { api: new FeishuBotEndpoints(http), fetchMock };
}

describe("FeishuBotEndpoints.getFeishuBot (role-polymorphic GET)", () => {
  it("reads an admin payload through the config branch", async () => {
    const { api } = endpoints({
      configured: true,
      workspace_id: "ws_1",
      app_id: "cli_abc",
      app_secret_configured: true,
      app_secret_hint: "cli_••••••",
    });
    const view = await api.getFeishuBot("ws_1");
    expect(view.role).toBe("admin");
    if (view.role !== "admin") throw new Error("expected the admin branch");
    expect(view.config.app_id).toBe("cli_abc");
    expect(view.config.app_secret_hint).toBe("cli_••••••");
  });

  it("reads the member projection through the availability branch", async () => {
    const { api } = endpoints({ configured: true, available: true, bot_name: "Remi" });
    const view = await api.getFeishuBot("ws_1");
    expect(view.role).toBe("member");
    if (view.role !== "member") throw new Error("expected the member branch");
    expect(view.availability).toEqual({ configured: true, available: true, bot_name: "Remi" });
  });

  it("never routes a member payload into the admin branch, even if it grows fields", async () => {
    // A member response gaining an unrelated field must not start looking like
    // a config; only `workspace_id` decides, and members never receive it.
    const { api } = endpoints({ configured: true, available: false, bot_name: null, degraded: true });
    const view = await api.getFeishuBot("ws_1");
    expect(view.role).toBe("member");
  });

  it("falls back to an unavailable bot when the body is not an object", async () => {
    const { api } = endpoints("nope");
    const view = await api.getFeishuBot("ws_1");
    expect(view).toEqual({
      role: "member",
      availability: { configured: false, available: false, bot_name: null },
    });
  });
});

describe("FeishuBotEndpoints control routes", () => {
  it("falls back to disabled empty Issue topics when the response drifts", async () => {
    const { api } = endpoints({
      workspace_id: 42,
      config: { enabled: "sometimes", chat_id: false, project_ids: "all" },
    });
    await expect(api.getIssueTopicConfig("ws_1")).resolves.toEqual({
      workspace_id: "",
      config: { enabled: false, chat_id: "", project_ids: null },
    });
  });

  it("sends the Issue topic project filter without changing null semantics", async () => {
    const { api, fetchMock } = endpoints({
      workspace_id: "ws_1",
      config: { enabled: true, chat_id: "oc_topics", project_ids: null },
    });
    await api.saveIssueTopicConfig("ws_1", {
      enabled: true,
      chat_id: "oc_topics",
      project_ids: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws_1/issue-topics", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, chat_id: "oc_topics", project_ids: null }),
    });
  });

  it("sends deploy and stop with an explicit empty JSON body", async () => {
    // The server parses these with `readJsonStrictAllowEmpty`, which only
    // tolerates an empty body when there is no content-type at all — so the
    // request has to carry a real `{}` rather than nothing.
    const { api, fetchMock } = endpoints({ status: "deploying", workspace_id: "ws_1" });
    await api.deployFeishuBot("ws_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws_1/feishu-bot/deploy", {
      method: "POST",
      body: "{}",
    });

    fetchMock.mockResolvedValue({ status: "stopped", workspace_id: "ws_1" });
    await api.stopFeishuBot("ws_1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces/ws_1/feishu-bot/stop", {
      method: "POST",
      body: "{}",
    });
  });

  it("passes a save request through untouched so `keep` semantics survive", async () => {
    const { api, fetchMock } = endpoints({ configured: true, workspace_id: "ws_1", app_id: "cli_abc" });
    await api.saveFeishuBot("ws_1", {
      agent_id: "agt_1",
      runtime_id: "rt_1",
      app_id: "cli_abc",
      domain: "feishu",
      enabled: false,
      app_secret_op: "keep",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.app_secret_op).toBe("keep");
    expect("app_secret" in body).toBe(false);
  });

  it("quotes a registration session instead of a secret when the credential was scanned", async () => {
    const { api, fetchMock } = endpoints({ configured: true, workspace_id: "ws_1", app_id: "cli_abc" });
    await api.saveFeishuBot("ws_1", {
      agent_id: "agt_1",
      runtime_id: "rt_1",
      app_id: "cli_abc",
      domain: "feishu",
      enabled: false,
      app_secret_op: "registration",
      registration_session_id: "reg_1",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.registration_session_id).toBe("reg_1");
    expect("app_secret" in body).toBe(false);
  });

  it("reports an unknown error code when a test response drifts", async () => {
    const { api } = endpoints({ ok: "maybe" });
    const result = await api.testFeishuBot("ws_1", { app_id: "cli_abc" });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("unknown");
  });
});

describe("FeishuBotEndpoints registration", () => {
  it("degrades a malformed session to a terminal error so the dialog stops polling", async () => {
    const { api } = endpoints({ session_id: 12, poll_interval_seconds: "soon" });
    const session = await api.beginFeishuBotRegistration("ws_1", "feishu");
    expect(session.status).toBe("error");
    expect(session.poll_interval_seconds).toBe(5);
  });

  it("keeps a pending session pending", async () => {
    const { api, fetchMock } = endpoints({
      session_id: "reg_1",
      status: "pending",
      verification_uri: "https://open.feishu.cn/qr",
      user_code: "ABCD-1234",
      poll_interval_seconds: 3,
    });
    const session = await api.getFeishuBotRegistration("ws_1", "reg_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws_1/feishu-bot/registration/reg_1");
    expect(session.status).toBe("pending");
    expect(session.app_secret_available).toBe(false);
  });
});
