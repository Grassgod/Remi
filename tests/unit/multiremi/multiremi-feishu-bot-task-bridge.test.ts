import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold() {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_sso_owner",
    feishuUnionId: "on_owner",
    email: owner.email,
    name: "Workspace Owner",
  });
  const agent = store.createAgent({ name: "Remi", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_bot",
    name: "codex",
    provider: "codex",
    workspaceId: "local",
    daemonId: "n37-066-008-hehuajie",
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_bot",
    appId: "cli_test",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  return { store, agent, config };
}

describe("Feishu bot standard Task bridge", () => {
  it("deduplicates events and steers an active Task in the bound Chat Session", () => {
    const { store, config } = scaffold();
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_1",
      senderOpenId: "ou_member",
      senderUnionId: "on_owner",
      senderName: "Owner from Feishu",
      text: "first message",
    });

    expect(first).toMatchObject({
      duplicate: false,
      steered: false,
      status: "queued",
      senderMembership: "member",
    });
    const task = store.getTask(first.taskId)!;
    expect(task).toMatchObject({
      chatSessionId: first.chatSessionId,
      runtimeId: "rt_bot",
      prompt: "first message",
      workDir: null,
      requestingUserName: "Workspace Owner",
      requestingUserProfileDescription: "Source: Feishu personal bot\nWorkspace membership: member\nWorkspace role: owner",
      issueCreationRestricted: false,
    });

    const duplicate = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_1",
      senderOpenId: "ou_member",
      senderUnionId: "on_owner",
      text: "redelivered payload",
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(store.listTasks().filter((candidate) => candidate.chatSessionId === first.chatSessionId)).toHaveLength(1);

    const steered = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_2",
      senderOpenId: "ou_member",
      senderUnionId: "on_owner",
      text: "add this while running",
    });
    expect(steered).toMatchObject({
      chatSessionId: first.chatSessionId,
      taskId: first.taskId,
      duplicate: false,
      steered: true,
    });
    expect(store.listPendingTaskSteerMessages(first.taskId)).toHaveLength(1);
    expect(store.listPendingTaskSteerMessages(first.taskId)[0]?.content).toBe("add this while running");
  });

  it("admits an unbound sender but attenuates Issue creation and labels the requester", () => {
    const { store, config } = scaffold();
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_external_chat",
      externalMessageId: "om_external",
      senderOpenId: "ou_external",
      senderUnionId: "on_external",
      senderName: "External Alice",
      text: "help me understand this workspace",
    });

    expect(submitted.senderMembership).toBe("unbound");
    expect(store.getTask(submitted.taskId)).toMatchObject({
      requestingUserName: "External Alice",
      requestingUserProfileDescription: "Source: Feishu personal bot\nWorkspace membership: unbound",
      issueCreationRestricted: true,
    });
  });

  it("distinguishes a known non-member from an unbound Feishu identity", () => {
    const { store, config } = scaffold();
    const outsider = store.getOrCreateUser({
      externalId: "ou_sso_outsider",
      feishuUnionId: "on_outsider",
      email: "outsider@example.com",
      name: "Known Outsider",
    });
    expect(store.getUserRoleInWorkspace(outsider.id, "local")).toBeNull();

    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_known_outsider",
      externalMessageId: "om_known_outsider",
      senderUnionId: "on_outsider",
      senderName: "Stale Event Name",
      text: "hello from another workspace",
    });

    expect(submitted.senderMembership).toBe("non_member");
    expect(store.getTask(submitted.taskId)).toMatchObject({
      requestingUserName: "Known Outsider",
      requestingUserProfileDescription: "Source: Feishu personal bot\nWorkspace membership: non_member",
      issueCreationRestricted: true,
    });
  });

  it("keeps the Chat Session across a config revision change", () => {
    const { store, config } = scaffold();
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_1",
      text: "before revision",
    });
    store.cancelTask(first.taskId);
    const revised = store.bumpFeishuBotRevision("local")!;

    const second = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: revised.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_2",
      text: "after revision",
    });
    expect(second.chatSessionId).toBe(first.chatSessionId);
    expect(second.taskId).not.toBe(first.taskId);
  });

  it("starts a fresh Chat Session when the configured Agent changes", () => {
    const { store, config } = scaffold();
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_1",
      text: "before Agent switch",
    });
    store.cancelTask(first.taskId);
    const nextAgent = store.createAgent({ name: "Remi 2", provider: "codex", workspaceId: "local" });
    const revised = store.upsertFeishuBotConfig("local", {
      agentId: nextAgent.id,
      runtimeId: "rt_bot",
      appId: "cli_test",
      appSecretOp: "keep",
      domain: "feishu",
      enabled: true,
    });

    const second = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: revised.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_2",
      text: "after Agent switch",
    });
    expect(second.chatSessionId).not.toBe(first.chatSessionId);
  });

  it("reports the bound Chat and latest canonical Task, then clears it on /new", () => {
    const { store, config } = scaffold();
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_1",
      externalMessageId: "om_1",
      text: "show status",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(submitted.taskId);
    store.startTask(submitted.taskId);
    store.reportTaskUsage(submitted.taskId, [{
      provider: "codex",
      model: "gpt-test",
      inputTokens: 12,
      outputTokens: 3,
    }]);
    store.completeTask(submitted.taskId, {
      output: "done",
      sessionId: "ses_1",
      workDir: "/workspaces/chats/chat_1",
    });

    expect(store.inspectFeishuBotSession("local", "rt_bot", config.revision, "oc_chat_1"))
      .toEqual({
        chatSessionId: submitted.chatSessionId,
        task: {
          taskId: submitted.taskId,
          status: "completed",
          result: "done",
          error: null,
          sessionId: "ses_1",
          workDir: "/workspaces/chats/chat_1",
          usage: [{
            provider: "codex",
            model: "gpt-test",
            inputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          }],
        },
      });

    expect(store.resetFeishuBotSession("local", "rt_bot", config.revision, "oc_chat_1")).toBe(true);
    expect(store.inspectFeishuBotSession("local", "rt_bot", config.revision, "oc_chat_1"))
      .toEqual({ chatSessionId: null, task: null });
  });
});
