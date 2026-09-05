import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeishuBotIdentityState,
  feishuAdmissionDenialMessage,
  flushDedupCacheSync,
  processFeishuMessageEvent,
  processFeishuMessageEventWithBotIdentity,
  setDedupCachePathForTesting,
  setGroupPolicy,
  type FeishuAdmissionDenialReason,
  type FeishuBotIdentityState,
} from "@connectors/feishu/receive.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import type { FeishuMessageEvent } from "@connectors/feishu/types.js";

let messageSequence = 0;
const dedupTestDir = mkdtempSync(join(tmpdir(), "remi-feishu-receive-"));

beforeAll(() => {
  setDedupCachePathForTesting(join(dedupTestDir, "dedup-cache.json"));
});

beforeEach(() => {
  setGroupPolicy({ getByChatId: () => null });
});

afterAll(() => {
  flushDedupCacheSync();
  rmSync(dedupTestDir, { recursive: true, force: true });
});

function uniqueMessageId(label: string): string {
  messageSequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${messageSequence}`;
}

function messageEvent(options: {
  messageId: string;
  senderOpenId: string;
  senderUserId?: string;
  senderUnionId?: string;
  senderTenantKey?: string;
  text?: string;
  chatType?: "p2p" | "group";
  chatId?: string;
  mentions?: FeishuMessageEvent["message"]["mentions"];
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: options.senderOpenId,
        user_id: options.senderUserId,
        union_id: options.senderUnionId,
      },
      tenant_key: options.senderTenantKey,
    },
    message: {
      message_id: options.messageId,
      chat_id: options.chatId ?? "oc_private_chat",
      chat_type: options.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: options.text ?? "hello" }),
      mentions: options.mentions,
    },
  };
}

function clientWithBasicBatchSender(name: string): { client: any; requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    client: {
      request: async (input: unknown) => {
        requests.push(input);
        return { data: { users: [{ name }] } };
      },
      contact: { user: { get: async () => { throw new Error("fallback should not run"); } } },
    },
    requests,
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

  it("resolves the sender with basic_batch and preserves cross-app identity fields", async () => {
    const senderOpenId = "ou_basic_batch";
    const { client, requests } = clientWithBasicBatchSender("External Alice");
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("basic-batch-sender"),
        senderOpenId,
        senderUserId: "7d9g83",
        senderUnionId: "on_union_alice",
        senderTenantKey: "tenant_a",
      }),
      undefined,
      gate.options,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/open-apis/contact/v3/users/basic_batch",
      params: { user_id_type: "open_id" },
      data: { user_ids: [senderOpenId] },
    });
    expect(result).toMatchObject({
      senderOpenId,
      senderUserId: "7d9g83",
      senderUnionId: "on_union_alice",
      senderTenantKey: "tenant_a",
      senderName: "External Alice",
    });
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

  it("silently rejects ordinary group chatter before group policy and sender resolution", async () => {
    const senderOpenId = "ou_non_member";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);
    let groupPolicyCalls = 0;
    setGroupPolicy({
      getByChatId: () => {
        groupPolicyCalls += 1;
        return null;
      },
    });
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
      expect(groupPolicyCalls).toBe(0);
      expect(gate.deniedReasons).toEqual([]);
      expect(warnSpy.mock.calls.flat().join(" ")).toContain("workspace membership denied");
      expect(warnSpy.mock.calls.flat().join(" ")).not.toContain(senderOpenId);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("notifies a non-member who mentions the bot in a group", async () => {
    const senderOpenId = "ou_non_member_mention";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("gate-non-member-mention"),
        senderOpenId,
        chatType: "group",
        chatId: "oc_unconfigured_group",
        text: "@_user_1 hello",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Remi" }],
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual(["not_member"]);
  });

  it("notifies a non-member who sends a slash command in a group", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("gate-non-member-command"),
        senderOpenId: "ou_non_member_command",
        chatType: "group",
        chatId: "oc_unconfigured_group",
        text: "/status",
      }),
      undefined,
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual(["not_member"]);
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

  it("rejects a missing sender open id without calling the membership lookup", async () => {
    const { client, getSenderCalls } = clientWithSender();
    let authorizationCalls = 0;
    const gate = admission(async () => {
      authorizationCalls += 1;
      return true;
    });

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({ messageId: uniqueMessageId("gate-missing-open-id"), senderOpenId: "" }),
      undefined,
      gate.options,
    );

    expect(result).toBeNull();
    expect(authorizationCalls).toBe(0);
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

describe("Feishu group message routing", () => {
  it("admits a bot mention when the production-default group policy returns null", async () => {
    const senderOpenId = "ou_group_mention_member";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-mention-no-policy"),
        senderOpenId,
        chatType: "group",
        chatId: "oc_group_mention_no_policy",
        text: "@_user_1 hello",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Remi" }],
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toMatchObject({
      senderOpenId,
      chatType: "group",
      mentionedBot: true,
      monitored: false,
      rawContent: "hello",
    });
    expect(getSenderCalls()).toBe(1);
    expect(gate.deniedReasons).toEqual([]);
  });

  it("admits a slash command when the production-default group policy returns null", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-slash-no-policy"),
        senderOpenId: "ou_group_slash_member",
        chatType: "group",
        chatId: "oc_group_slash_no_policy",
        text: "/status",
      }),
      undefined,
      gate.options,
    );

    expect(result).toMatchObject({
      chatType: "group",
      mentionedBot: false,
      monitored: false,
      rawContent: "/status",
    });
    expect(getSenderCalls()).toBe(1);
    expect(gate.deniedReasons).toEqual([]);
  });

  it("drops ordinary group chatter without sending a denial card or resolving the sender", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-chatter"),
        senderOpenId: "ou_group_chatter_member",
        chatType: "group",
        chatId: "oc_group_chatter",
        text: "hello everyone",
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual([]);
  });

  it("drops a group message directed at someone other than the bot", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-other-mention"),
        senderOpenId: "ou_group_other_mention_member",
        chatType: "group",
        chatId: "oc_group_other_mention",
        text: "@_user_2 hello",
        mentions: [{ key: "@_user_2", id: { open_id: "ou_other" }, name: "Other" }],
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual([]);
  });

  it("denies a non-member bot mention before sender resolution", async () => {
    const senderOpenId = "ou_non_member_group_regression";
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => false);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-non-member-regression"),
        senderOpenId,
        chatType: "group",
        chatId: "oc_group_non_member_regression",
        text: "@_user_1 hello",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Remi" }],
      }),
      "ou_bot",
      gate.options,
    );

    expect(result).toBeNull();
    expect(getSenderCalls()).toBe(0);
    expect(gate.deniedReasons).toEqual(["not_member"]);
  });

  it("waits for bot identity before classifying an early group mention", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);
    let markReady!: () => void;
    const botIdentity: FeishuBotIdentityState = {
      botOpenIdReady: new Promise<void>((resolve) => {
        markReady = () => {
          botIdentity.botOpenId = "ou_bot";
          resolve();
        };
      }),
    };

    const processing = processFeishuMessageEventWithBotIdentity(
      client,
      messageEvent({
        messageId: uniqueMessageId("group-early-mention"),
        senderOpenId: "ou_group_early_mention_member",
        chatType: "group",
        chatId: "oc_group_early_mention",
        text: "@_user_1 hello",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Remi" }],
      }),
      botIdentity,
      gate.options,
      100,
    );

    await Promise.resolve();
    expect(getSenderCalls()).toBe(0);
    markReady();

    expect(await processing).toMatchObject({ mentionedBot: true, monitored: false });
    expect(getSenderCalls()).toBe(1);
  });

  it("logs dropped group messages with a hash and no raw identity", async () => {
    const senderOpenId = "ou_sensitive_sender";
    const chatId = "oc_sensitive_chat";
    const { client } = clientWithSender();
    const gate = admission(async () => true);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await processFeishuMessageEvent(
        client,
        messageEvent({
          messageId: uniqueMessageId("group-log-redaction"),
          senderOpenId,
          chatType: "group",
          chatId,
          text: "hello everyone",
        }),
        "ou_bot",
        gate.options,
      );

      expect(result).toBeNull();
      const logs = logSpy.mock.calls.flat().join(" ");
      expect(logs).toContain("reason=not_mentioned");
      expect(logs).toContain("chat_hash=");
      expect(logs).not.toContain(chatId);
      expect(logs).not.toContain(senderOpenId);
      expect(logs).not.toContain("ou_bot");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs an unresolved bot identity without exposing raw identifiers", async () => {
    const senderOpenId = "ou_unresolved_sensitive_sender";
    const chatId = "oc_unresolved_sensitive_chat";
    const { client } = clientWithSender();
    const gate = admission(async () => true);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await processFeishuMessageEvent(
        client,
        messageEvent({
          messageId: uniqueMessageId("group-unresolved-log-redaction"),
          senderOpenId,
          chatType: "group",
          chatId,
          text: "@_user_1 hello",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_unresolved_target" }, name: "Remi" }],
        }),
        undefined,
        gate.options,
      );

      expect(result).toBeNull();
      const logs = logSpy.mock.calls.flat().join(" ");
      expect(logs).toContain("reason=bot_open_id_unresolved");
      expect(logs).toContain("chat_hash=");
      expect(logs).not.toContain(chatId);
      expect(logs).not.toContain(senderOpenId);
      expect(logs).not.toContain("ou_unresolved_target");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps p2p messages independent of bot identity and group policy", async () => {
    const { client, getSenderCalls } = clientWithSender();
    const gate = admission(async () => true);

    const result = await processFeishuMessageEvent(
      client,
      messageEvent({
        messageId: uniqueMessageId("p2p-regression"),
        senderOpenId: "ou_p2p_regression_member",
        text: "hello",
      }),
      undefined,
      gate.options,
    );

    expect(result).toMatchObject({ chatType: "p2p", rawContent: "hello" });
    expect(getSenderCalls()).toBe(1);
    expect(gate.deniedReasons).toEqual([]);
  });
});

describe("Feishu bot identity readiness", () => {
  it("retries with 1s/2s/4s backoff and bypasses the probe cache", async () => {
    const calls: Array<{ skipCache?: boolean }> = [];
    const delays: number[] = [];
    const state = createFeishuBotIdentityState(
      { appId: "app", appSecret: "secret" },
      {
        probe: async (_creds, options) => {
          calls.push(options ?? {});
          return calls.length === 4
            ? { ok: true, botOpenId: "ou_bot" }
            : { ok: false, error: "temporary" };
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    await state.botOpenIdReady;

    expect(state.botOpenId).toBe("ou_bot");
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(calls).toEqual([
      { skipCache: false },
      { skipCache: true },
      { skipCache: true },
      { skipCache: true },
    ]);
  });

  it("reports final probe failure as degraded without logging credentials", async () => {
    const appId = "app_sensitive_identity";
    const appSecret = "secret_sensitive_identity";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const state = createFeishuBotIdentityState(
        { appId, appSecret },
        {
          backoffMs: [],
          probe: async () => ({ ok: false, error: "provider payload" }),
        },
      );

      await state.botOpenIdReady;

      const logs = errorSpy.mock.calls.flat().join(" ");
      expect(logs).toContain("group @mention detection is degraded");
      expect(logs).not.toContain(appId);
      expect(logs).not.toContain(appSecret);
      expect(logs).not.toContain("provider payload");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
