import { describe, expect, it } from "bun:test";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { sendMessageFeishu } from "@connectors/feishu/send.js";

describe("Feishu message sending", () => {
  it("passes the durable delivery id as the reply uuid", async () => {
    const calls: unknown[] = [];
    const client = {
      im: {
        message: {
          reply: async (input: unknown) => {
            calls.push(input);
            return { code: 0, data: { message_id: "om_sent" } };
          },
        },
      },
    } as unknown as Lark.Client;

    const result = await sendMessageFeishu(client, "oc_topic", "Round complete.", {
      replyToMessageId: "om_root",
      idempotencyKey: "fbo_stable_delivery",
    });

    expect(result.messageId).toBe("om_sent");
    expect(calls).toEqual([{
      path: { message_id: "om_root" },
      data: expect.objectContaining({
        msg_type: "post",
        reply_in_thread: true,
        uuid: "fbo_stable_delivery",
      }),
    }]);
  });
});
