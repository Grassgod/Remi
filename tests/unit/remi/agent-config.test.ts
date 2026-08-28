import { afterEach, expect, test } from "bun:test";
import { bootFeishuChannel, feishuConfigured } from "../../../apps/remi/cli/agent.js";

const originalAppId = process.env.FEISHU_APP_ID;
const originalAppSecret = process.env.FEISHU_APP_SECRET;

afterEach(() => {
  if (originalAppId === undefined) delete process.env.FEISHU_APP_ID;
  else process.env.FEISHU_APP_ID = originalAppId;
  if (originalAppSecret === undefined) delete process.env.FEISHU_APP_SECRET;
  else process.env.FEISHU_APP_SECRET = originalAppSecret;
});

test("clean env keeps Feishu optional but an explicit bot boot reports missing env", async () => {
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;

  expect(feishuConfigured()).toBe(false);
  await expect(bootFeishuChannel({} as never, [], async () => true)).rejects.toThrow(
    "Feishu channel cannot start; missing env: FEISHU_APP_ID, FEISHU_APP_SECRET",
  );
});

test("a partial Feishu credential pair fails closed", () => {
  process.env.FEISHU_APP_ID = "configured-app";
  delete process.env.FEISHU_APP_SECRET;

  expect(() => feishuConfigured()).toThrow(
    "Feishu channel cannot start; missing env: FEISHU_APP_SECRET",
  );
});
