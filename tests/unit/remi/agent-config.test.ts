import { expect, test } from "bun:test";
import { bootFeishuChannel, waitForFeishuConnectorStart } from "../../../apps/remi/cli/agent.js";

test("a control-plane assignment with incomplete credentials fails closed", async () => {
  await expect(bootFeishuChannel(async () => true, {
    credentials: { appId: "configured-app", appSecret: "", domain: "feishu" },
    taskHandler: async () => {},
  })).rejects.toThrow(
    "Feishu channel cannot start; the configured bot is missing an App ID or App Secret",
  );
});

test("a control-plane channel waits for the WebSocket handshake", async () => {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  let stopped = 0;
  const connector = {
    waitUntilReady: () => ready,
    stop: async () => { stopped += 1; },
  };
  const start = new Promise<void>(() => {});

  let settled = false;
  const waiting = waitForFeishuConnectorStart(connector, start).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  resolveReady();
  await waiting;
  expect(stopped).toBe(0);
});

test("a failed WebSocket handshake closes the partial connector", async () => {
  let stopped = 0;
  const connector = {
    waitUntilReady: () => Promise.reject(new Error("handshake failed")),
    stop: async () => { stopped += 1; },
  };

  await expect(waitForFeishuConnectorStart(connector, new Promise<void>(() => {})))
    .rejects.toThrow("handshake failed");
  expect(stopped).toBe(1);
});
