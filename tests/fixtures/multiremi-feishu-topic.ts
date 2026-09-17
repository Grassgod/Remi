import { expect } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";

/** Run `body` against an enabled, online bot config on the caller's runtime. */
function withFeishuBot<T>(
  store: MultiremiStore,
  input: { runtimeId: string; agentId: string },
  body: (revision: number) => T,
): T {
  store.ensureLocalWorkspace();
  store.heartbeatRuntime(input.runtimeId, { supportsFeishuBotConfig: true });
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  try {
    const config = store.upsertFeishuBotConfig("local", {
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      appId: "cli_wire_topic",
      appSecretOp: "set",
      appSecret: "test-wire-topic-secret",
      domain: "feishu",
      enabled: true,
    });
    store.reportFeishuBotRuntimeStatus("local", input.runtimeId, {
      appliedRevision: config.revision,
      state: "online",
    });
    return body(config.revision);
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
}

/** Create and publish a topic through the public store paths for daemon tests. */
export function prepareFeishuIssueTopic(
  store: MultiremiStore,
  input: { runtimeId: string; agentId: string; issueId: string },
) {
  return withFeishuBot(store, input, () => {
    const workspace = store.getWorkspace("local")!;
    store.updateWorkspace("local", {
      settings: { ...workspace.settings, issueTopics: { enabled: true, chatId: "oc_wire_topics" } },
    });
    expect(store.prepareFeishuIssueTopicWithinTransaction(store.getIssue(input.issueId)!)).toBe(true);
    const root = store.claimFeishuBotOutbound("local", input.runtimeId)!;
    store.reportFeishuBotOutbound("local", input.runtimeId, root.id, {
      claimToken: root.claimToken,
      status: "sent",
      externalMessageId: `om_wire_${input.issueId}`,
    });
    const chat = store.getChatSession(`chat_issue_topic_${input.issueId}`)!;
    expect(store.getFeishuIssueIdForChatSession(chat.id)).toBe(input.issueId);
    expect(chat).not.toHaveProperty("issueId");
    return chat;
  });
}

/**
 * Deliver one inbound direct message, producing the Issue-less Chat the
 * connector uses as transport for a private Feishu conversation.
 */
export function prepareFeishuPrivateConversation(
  store: MultiremiStore,
  input: { runtimeId: string; agentId: string; senderOpenId: string; text?: string },
) {
  return withFeishuBot(store, input, (revision) => {
    const inbound = store.submitFeishuBotMessage("local", input.runtimeId, {
      revision,
      externalSessionKey: `p2p:${input.senderOpenId}`,
      externalMessageId: `om_private_${input.senderOpenId}`,
      chatId: `oc_private_${input.senderOpenId}`,
      chatType: "p2p",
      senderOpenId: input.senderOpenId,
      text: input.text ?? "Private Feishu message",
    });
    const chat = store.getChatSession(inbound.chatSessionId)!;
    expect(store.getFeishuIssueIdForChatSession(chat.id)).toBeNull();
    return { chat, taskId: inbound.taskId };
  });
}
