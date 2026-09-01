import { expect, test } from "bun:test";
import { bootFeishuChannel } from "../../../apps/remi/cli/agent.js";

test("a control-plane assignment with incomplete credentials fails closed", async () => {
  await expect(bootFeishuChannel(async () => true, {
    credentials: { appId: "configured-app", appSecret: "", domain: "feishu" },
    taskHandler: async () => {},
  })).rejects.toThrow(
    "Feishu channel cannot start; the configured bot is missing an App ID or App Secret",
  );
});
