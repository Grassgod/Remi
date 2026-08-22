import { afterEach, describe, expect, it } from "bun:test";
import type { FeishuMultiremiConfig } from "@shared/config.js";
import {
  FeishuMultiremiClient,
  shouldRouteFeishuMessageToMultiremi,
} from "@connectors/feishu/multiremi.js";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("Feishu Multiremi routing", () => {
  const disabled: FeishuMultiremiConfig = {
    enabled: false,
    serverUrl: "http://127.0.0.1:6120",
    token: "token",
    workspaceId: "local",
  };

  it("only diverts p2p messages when explicitly enabled", () => {
    expect(shouldRouteFeishuMessageToMultiremi(disabled, "p2p")).toBe(false);
    expect(shouldRouteFeishuMessageToMultiremi({ ...disabled, enabled: true }, "p2p")).toBe(true);
    expect(shouldRouteFeishuMessageToMultiremi({ ...disabled, enabled: true }, "group")).toBe(false);
    expect(shouldRouteFeishuMessageToMultiremi(undefined, "p2p")).toBe(false);
  });
});

describe("FeishuMultiremiClient", () => {
  it("runs resolve, send, poll, and assistant-message fetch against a mock server", async () => {
    const calls: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
    let taskPolls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        let body: unknown = null;
        if (request.method === "POST") body = await request.json();
        calls.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("Authorization"),
          body,
        });
        if (url.pathname === "/api/chat/external/resolve") {
          return Response.json({ id: "chat_feishu" });
        }
        if (url.pathname === "/api/chat/sessions/chat_feishu/messages" && request.method === "POST") {
          return Response.json({ message_id: "msg_user", task_id: "tsk_chat", created_at: new Date().toISOString() }, { status: 201 });
        }
        if (url.pathname === "/api/multiremi/tasks/tsk_chat") {
          taskPolls += 1;
          return Response.json({ task: { id: "tsk_chat", status: taskPolls === 1 ? "running" : "completed" } });
        }
        if (url.pathname === "/api/chat/sessions/chat_feishu/messages" && request.method === "GET") {
          return Response.json([
            { id: "msg_user", role: "user", task_id: "tsk_chat", content: "MUL-69 怎么样了" },
            { id: "msg_assistant", role: "assistant", task_id: "tsk_chat", content: "MUL-69 正在实现一期桥接。" },
          ]);
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(server);
    const client = new FeishuMultiremiClient({
      enabled: true,
      serverUrl: `http://127.0.0.1:${server.port}/`,
      token: "member-token",
      workspaceId: "ws concierge",
    }, { pollIntervalMs: 1, timeoutMs: 1_000 });

    const response = await client.sendMessage("oc_p2p", "MUL-69 怎么样了");

    expect(response).toBe("MUL-69 正在实现一期桥接。");
    expect(taskPolls).toBe(2);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/chat/external/resolve?workspace_id=ws%20concierge",
      "POST /api/chat/sessions/chat_feishu/messages",
      "GET /api/multiremi/tasks/tsk_chat",
      "GET /api/multiremi/tasks/tsk_chat",
      "GET /api/chat/sessions/chat_feishu/messages",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer member-token")).toBe(true);
    expect(calls[0]!.body).toEqual({ source: "feishu", external_chat_id: "oc_p2p" });
    expect(calls[1]!.body).toEqual({ content: "MUL-69 怎么样了" });
  });

  it("surfaces failed and timed-out tasks", async () => {
    const baseConfig: FeishuMultiremiConfig = {
      enabled: true,
      serverUrl: "http://multiremi.test",
      token: "member-token",
      workspaceId: "local",
    };
    const responses = (status: string) => async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/chat/external/resolve") return Response.json({ id: "chat_1" });
      if (path === "/api/chat/sessions/chat_1/messages") return Response.json({ task_id: "tsk_1" });
      return Response.json({ task: { status, error: status === "failed" ? "provider unavailable" : null } });
    };

    const failed = new FeishuMultiremiClient(baseConfig, { fetch: responses("failed") });
    await expect(failed.sendMessage("oc_1", "hello")).rejects.toThrow("provider unavailable");

    const timedOut = new FeishuMultiremiClient(baseConfig, {
      fetch: responses("running"),
      pollIntervalMs: 1,
      timeoutMs: 0,
    });
    await expect(timedOut.sendMessage("oc_1", "hello")).rejects.toThrow("timed out");
  });
});
