/**
 * The Feishu (Lark) HTTP client: tenant_access_token acquisition + caching, and
 * IM v1 text send. Pure HTTP — driven with an injected fake fetch, no network,
 * no DB.
 */

import { test, expect } from "bun:test";
import { LarkClient } from "../src/lark/client.js";

interface Call {
  url: string;
  authorization?: string;
  body: any;
}

function fakeHttp(opts?: { tokenCode?: number }) {
  const calls: Call[] = [];
  let tokenHits = 0;
  const fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, authorization: headers["Authorization"], body });
    if (u.includes("/auth/v3/tenant_access_token/internal")) {
      tokenHits++;
      const code = opts?.tokenCode ?? 0;
      return new Response(
        JSON.stringify(code === 0 ? { code: 0, tenant_access_token: "t-abc", expire: 7200 } : { code, msg: "bad app" }),
        { status: 200 },
      );
    }
    if (u.includes("/im/v1/messages")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_123" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 99, msg: "unknown" }), { status: 200 });
  }) as typeof fetch;
  return { http: { fetch }, calls, tokenHits: () => tokenHits };
}

test("tenantAccessToken posts credentials and returns the token", async () => {
  const f = fakeHttp();
  const client = new LarkClient("cli_app", "secret", { http: f.http });
  const token = await client.tenantAccessToken();
  expect(token).toBe("t-abc");
  const tokenCall = f.calls.find((c) => c.url.includes("tenant_access_token"))!;
  expect(tokenCall.url).toBe("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
  expect(tokenCall.body).toEqual({ app_id: "cli_app", app_secret: "secret" });
});

test("the token is cached across calls (the token endpoint is hit once)", async () => {
  const f = fakeHttp();
  const client = new LarkClient("cli_app", "secret", { http: f.http });
  await client.replyText("oc_chat", "hello");
  await client.replyText("oc_chat", "again");
  expect(f.tokenHits()).toBe(1);
});

test("sendMessage posts to im/v1/messages with Bearer auth and a JSON text content", async () => {
  const f = fakeHttp();
  const client = new LarkClient("cli_app", "secret", { http: f.http });
  const res = await client.replyText("oc_chat", "fix the bug");
  expect(res.messageId).toBe("om_123");
  const msgCall = f.calls.find((c) => c.url.includes("/im/v1/messages"))!;
  expect(msgCall.url).toContain("receive_id_type=chat_id");
  expect(msgCall.authorization).toBe("Bearer t-abc");
  expect(msgCall.body.receive_id).toBe("oc_chat");
  expect(msgCall.body.msg_type).toBe("text");
  expect(JSON.parse(msgCall.body.content)).toEqual({ text: "fix the bug" });
});

test("a non-zero Lark error code throws", async () => {
  const f = fakeHttp({ tokenCode: 99991663 });
  const client = new LarkClient("cli_app", "secret", { http: f.http });
  await expect(client.tenantAccessToken()).rejects.toThrow(/code=99991663/);
});
