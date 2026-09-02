import { describe, expect, it } from "bun:test";
import * as Lark from "@larksuiteoapi/node-sdk";
import { resolveLarkSdkDomain, waitForFeishuWSReady } from "@connectors/feishu/client.js";

describe("resolveLarkSdkDomain", () => {
  it("uses SDK constants for the public Feishu clouds", () => {
    expect(resolveLarkSdkDomain()).toBe(Lark.Domain.Feishu);
    expect(resolveLarkSdkDomain("feishu")).toBe(Lark.Domain.Feishu);
    expect(resolveLarkSdkDomain("lark")).toBe(Lark.Domain.Lark);
  });

  it("uses the full ByteDance origin for the SDK", () => {
    expect(resolveLarkSdkDomain("bytedance")).toBe("https://fsopen.bytedance.net");
  });

  it("preserves a custom origin and strips trailing slashes", () => {
    expect(resolveLarkSdkDomain("https://feishu.example.com///")).toBe("https://feishu.example.com");
  });
});

describe("waitForFeishuWSReady", () => {
  it("waits for the SDK WebSocket to open", async () => {
    const socket = { readyState: 0 };
    const client = {
      wsConfig: { getWSInstance: () => socket },
    } as unknown as Lark.WSClient;

    const ready = waitForFeishuWSReady(client, { timeoutMs: 100, pollIntervalMs: 1 });
    setTimeout(() => { socket.readyState = 1; }, 5);

    await expect(ready).resolves.toBeUndefined();
  });

  it("rejects instead of reporting online when the handshake never opens", async () => {
    const client = {
      wsConfig: { getWSInstance: () => null },
    } as unknown as Lark.WSClient;

    await expect(waitForFeishuWSReady(client, { timeoutMs: 5, pollIntervalMs: 1 }))
      .rejects.toThrow("did not connect");
  });
});
