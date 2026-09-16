import { expect } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";

/** Create and publish a topic through the public store paths for daemon tests. */
export function prepareFeishuIssueTopic(
  store: MultiremiStore,
  input: { runtimeId: string; agentId: string; issueId: string },
) {
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
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
}
