import { describe, expect, it, spyOn } from "bun:test";
import {
  feishuAdmissionDenialMessage,
  processFeishuMessageEvent,
  setGroupPolicy,
  type FeishuAdmissionDenialReason,
} from "@connectors/feishu/receive.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import type { FeishuMessageEvent } from "@connectors/feishu/types.js";

let messageSequence = 0;
function uniqueMessageId(label: string): string {
  messageSequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${messageSequence}`;
}

function messageEvent(options: {
  messageId: string;
  senderOpenId: string;
  chatType?: "p2p" | "group";
  chatId?: string;
  mentions?: FeishuMessageEvent["message"]["mentions"];
}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: options.senderOpenId } },
    message: {
      message_id: options.messageId,
      chat_id: options.chatId ?? "oc_private_chat",
      chat_type: options.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: options.mentions,
    },
  };
}

function clientWithSender(name = "Alice"): { client: any; getSenderCalls: () => number } {
  let calls = 0;
  return {
    client: {
      contact: {
        user: {
          get: async () => {
            calls += 1;
            return { data: { user: { name } } };
          },
        },
      },
    },
    getSenderCalls: () => calls,
  };
}

function admission(
  authorizeSender: (senderOpenId: string) => Promise<boolean>,
): {
  options: {
    authorizeSender: (senderOpenId: string) => Promise<boolean>;
    onDenied: (_context: unknown, reason: FeishuAdmissionDenialReason) => Promise<void>;
  };
  deniedReasons: FeishuAdmissionDenialReason[];
} {
  const deniedReasons: FeishuAdmissionDenialReason[] = [];
  return {
    options: {
      authorizeSender,
      onDenied: async (_context, reason) => {
        deniedReasons.push(reason);
      },
    },
    deniedReasons,
  };
}

describe("Feishu workspace membership admission", () => {
  it("refuses to connect when no membership authorizer was injected", () => {
    const channel = new FeishuChannel({ appId: "app", appSecret: "secret" });
    expect(() => channel.connect()).toThrow("workspace membership authorizer is required");
  });

  it("allows a workspace member in a p2p chat", async () => {
    const senderOpenId = "ou_member_p2p";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async (received) => received === senderOpenId);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({ messageId: uniqueMessageId("gate-member-p2p"), senderOpenId }),
      undefined,
      gate.options,
    );

    expect(result).toMatchObject({ senderOpenId, chatType: "p2p" });
    expect(getSenderCalls()).toBe(1);
    expect(gate.deniedReasons).toEqual([]);
  });

  it("allows a workspace member in an admitted group", async () => {
    const senderOpenId = "ou_member_group";
    const { client } = clientWithSender();
    setGroupPolicy({
      getByChatId: (chatId) => chatId === "oc_allowed_group" ? { monitor: false } : null,
    });
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("gate-member-group"),
        senderOpenId,
        chatType: "group",
        chatId: "oc_allowed_group",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Remi" }],
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toMatchObject({ senderOpenId, chatType: "group", mentionedBot: true });
    expect(gate.deniedReasons).toEqual([]);
  });

  it("rejects a non-member before group policy and sender resolution", async () => {
    const senderOpenId = "ou_non_member";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await processFeishuMessageEvent(
        client,
        messageEvent({
          messageId: uniqueMessageId("gate-non-member-group"),
          senderOpenId,
          chatType: "group",
          chatId: "oc_unconfigured_group",
        }),
        undefined,
        gate.options,
      );

      expect(result).toBeNull();
      expect(getSenderCalls()).toBe(0);
      expect(gate.deniedReasons).toEqual(["not_member"]);
      expect(warnSpy.mock.calls.flat().join(" ")).toContain("workspace membership denied");
      expect(warnSpy.mock.calls.flat().join(" ")).not.toContain(senderOpenId);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects an unknown external user without entering the message pipeline", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({ messageId: uniqueMessageId("gate-unknown-user"), senderOpenId: "ou_unknown" }),
      undefined,
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual(["not_member"]);
  });

  it("fails closed and reports an unavailable gate when membership lookup throws", async () => {
    const senderOpenId = "ou_lookup_failure";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => { throw new Error("service unavailable"); });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await processFeishuMessageEvent(
        client,
        messageEvent({ messageId: uniqueMessageId("gate-query-error"), senderOpenId }),
        undefined,
        gate.options,
      );

      expect(result).toBeNull();
      expect(getSenderCalls()).toBe(0);
      expect(gate.deniedReasons).toEqual(["unavailable"]);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("membership lookup failed");
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(senderOpenId);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("uses user-visible denial text without exposing identifiers", () => {
    for (const reason of ["not_member", "unavailable"] as const) {
      const text = feishuAdmissionDenialMessage(reason);
      expect(text).toContain("workspace");
      expect(text).not.toContain("ou_");
      expect(text).not.toContain("workspace_id");
    }
  });
});
