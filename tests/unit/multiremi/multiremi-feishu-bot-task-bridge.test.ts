import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
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
  it("switches the bound Chat from bootstrap to delta after the provider session is promoted", () => {
    const { store, agent, config } = scaffold();
    store.updateAgent(agent.id, { instructions: "Follow the workspace rules.\n".repeat(400) });
    const skill = store.createSkill({
      name: "Feishu prompt fixture",
      description: "Static bootstrap content",
      content: "Inspect the repository carefully.\n".repeat(400),
    });
    store.setAgentSkills(agent.id, { skillIds: [skill.id!] });

    const firstSubmission = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_delta",
      externalMessageId: "om_delta_1",
      senderOpenId: "ou_member",
      senderUnionId: "on_owner",
      text: "first Feishu request",
    });
    const firstTask = store.claimTask("rt_bot")!;
    expect(firstTask.id).toBe(firstSubmission.taskId);
    const firstWire = daemonTaskClaimResponse(store, firstTask);
    expect((firstWire.session_projection as { mode?: string } | undefined)?.mode).toBe("bootstrap");
    const firstPrompt = buildTaskPrompt({
      ...firstTask,
      sessionProjection: firstWire.session_projection,
      chatMessage: firstWire.chat_message,
    } as any);

    store.startTask(firstTask.id);
    store.completeTask(firstTask.id, { output: "first answer", sessionId: "sess_feishu_delta" });
    const issue = store.createIssue({ title: "Feishu bound Chat", workspaceId: "local" });
    store.updateChatSession(firstSubmission.chatSessionId, { issueId: issue.id });
    const secondSubmission = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_chat_delta",
      externalMessageId: "om_delta_2",
      senderOpenId: "ou_member",
      senderUnionId: "on_owner",
      text: "second Feishu request",
    });
    const secondTask = store.claimTask("rt_bot")!;
    expect(secondTask.id).toBe(secondSubmission.taskId);
    const secondWire = daemonTaskClaimResponse(store, secondTask);
    expect((secondWire.session_projection as { mode?: string } | undefined)?.mode).toBe("delta");
    const secondPrompt = buildTaskPrompt({
      ...secondTask,
      sessionProjection: secondWire.session_projection,
      chatMessage: secondWire.chat_message,
    } as any);

    expect(secondPrompt).toContain(`## Issue\nKey: ${issue.key}`);
    expect(secondPrompt.match(/second Feishu request/g)).toHaveLength(1);
    expect(secondPrompt).not.toContain("## Agent Instructions");
    expect(secondPrompt).not.toContain("## Skills");
    expect(Buffer.byteLength(secondPrompt)).toBeLessThan(Buffer.byteLength(firstPrompt) / 2);
  });

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
