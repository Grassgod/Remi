import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import type { IncomingMessage, TaskStreamMeta } from "@connectors/base.js";
import { createFeishuTaskHandler } from "../../../apps/remi/cli/multiremi.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  it("queues direct, group, and Issue topic replies with the resolved Agent and original conversation", async () => {
    const { store, config } = scaffold();
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
    const direct = store.createAgent({ name: "Direct", provider: "codex", workspaceId: "local" });
    const broad = store.createAgent({ name: "Broad", provider: "codex", workspaceId: "local" });
    const issueWorker = store.createAgent({ name: "Issue worker", provider: "codex", workspaceId: "local" });
    store.updateWorkspace("local", {
      settings: { issueTopics: { enabled: true, chatId: "oc_issue_topic" } },
    });
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "p2p_default", agentId: direct.id },
      { scope: "group_default", agentId: broad.id },
      { scope: "chat", chatId: "oc_issue_topic", agentId: issueWorker.id },
    ]);
    const daemon = {
      submitFeishuBotMessage: async (input: Parameters<MultiremiDaemon["submitFeishuBotMessage"]>[0]) =>
        store.submitFeishuBotMessage("local", "rt_bot", input),
      respondFeishuBotHumanRequest: async () => { throw new Error("not expected"); },
    } as unknown as MultiremiDaemon;
    const handler = createFeishuTaskHandler(daemon, config.revision, "Startup default");
    const cases = [
      { chatType: "p2p", chatId: "oc_direct", sessionKey: "ou_direct", messageId: "om_direct", expected: "Direct" },
      {
        chatType: "group",
        chatId: "oc_general",
        sessionKey: "oc_general:thread:omt_general",
        messageId: "om_general",
        expected: "Broad",
      },
      {
        chatType: "group",
        chatId: "oc_issue_topic",
        sessionKey: "oc_issue_topic:thread:omt_issue",
        messageId: "om_issue",
        expected: "Issue worker",
      },
    ] as const;

    for (const scenario of cases) {
      const metas: TaskStreamMeta[] = [];
      const message: IncomingMessage = {
        chatId: scenario.chatId,
        text: `message for ${scenario.expected}`,
        metadata: {
          messageId: scenario.messageId,
          chatType: scenario.chatType,
          rootId: scenario.chatType === "group" ? scenario.sessionKey.split(":thread:")[1] : null,
          senderUnionId: "on_owner",
          senderOpenId: "ou_requester",
        },
      };
      await handler(message, scenario.sessionKey, async (_stream, streamMeta) => {
        metas.push(streamMeta);
      });
      expect(metas).toHaveLength(0);
      expect(store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)).toBeNull();
      const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true)!;
      expect(delivery).toMatchObject({ chatId: scenario.chatId, replyToMessageId: scenario.messageId,
        interactionOpenId: "ou_requester", presentation: { version: "native_cot_v1" } });
      expect(store.getTaskWithAgent(delivery.taskId!)?.agent?.name).toBe(scenario.expected);
      expect(delivery.mention?.resolvedOpenId).toBe(scenario.chatType === "group" ? "ou_requester" : null);
    }
  });

  it("wakes once after a lead round and durably retries the proactive topic reply", () => {
    const { store, agent, config } = scaffold();
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_round_push:thread:omt_round_push",
      externalMessageId: "om_round_push_1",
      replyToMessageId: "om_round_push_1",
      chatId: "oc_round_push",
      threadId: "omt_round_push",
      senderUnionId: "on_owner",
      text: "Create and track this Issue.",
    });
    store.cancelTask(inbound.taskId);
    const issue = store.createIssue({
      title: "Proactive Feishu round",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.registerRuntime({
      id: "rt_issue_workspace",
      name: "issue-codex",
      provider: "codex",
      workspaceId: "local",
      daemonId: "n37-206-133-hehuajie",
    });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: "rt_issue_workspace",
      rootPath: "/tmp/MUL-topic-report",
      branchName: `agent/${issue.key}`,
      status: "ready",
      repos: [],
    });
    store.updateChatSession(inbound.chatSessionId, { issueId: issue.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const leaderTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Complete the assigned work.",
    });
    expect(store.claimTask("rt_bot")).toBeNull();
    expect(store.claimTask("rt_issue_workspace")?.id).toBe(leaderTask.id);
    store.startTask(leaderTask.id);

    const taskCountBeforeComment = store.listTasks().length;
    store.queueAgentIssueUpdate({
      activityId: "act_round_progress",
      issueId: issue.id,
      actorType: "member",
      actorId: "local",
      type: "comment_created",
      body: "Include the migration result in the final summary.",
      createdAt: new Date().toISOString(),
    });
    expect(store.listTasks()).toHaveLength(taskCountBeforeComment);

    store.completeTask(leaderTask.id, {
      output: "The implementation and migration are complete.",
      sessionId: "sess_leader_round",
    });
    const roundTasks = store.listTasks().filter((task) =>
      task.chatSessionId === inbound.chatSessionId && task.status === "queued"
    );
    expect(roundTasks).toHaveLength(1);
    expect(store.listIssueSessions(issue.id)).toHaveLength(1);

    const roundTask = roundTasks[0]!;
    expect(roundTask).toMatchObject({ holdsWorkspace: false, runtimeId: "rt_bot" });
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
    // A v3 daemon must not send an empty body; v4 starts streaming before completion.
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();
    const streamClaim = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(streamClaim).toMatchObject({ taskId: roundTask.id, body: "", resumeMessageId: null });
    expect(store.reportFeishuBotOutbound("local", "rt_bot", streamClaim.id, {
      claimToken: streamClaim.claimToken, status: "streaming", externalMessageId: "om_live_card",
    })).toBe(true);
    expect(store.getTaskWithAgent(roundTask.id)?.repos).toEqual([]);
    expect(store.claimTask("rt_bot")?.id).toBe(roundTask.id);
    const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(roundTask.id)!);
    expect(wire.bound_issue_updates).toEqual([
      expect.stringContaining("The implementation and migration are complete."),
    ]);
    store.startTask(roundTask.id);
    store.failTask(roundTask.id, {
      error: "temporary provider timeout",
      failureReason: "timeout",
      sessionId: "sess_round_push_retry",
    });
    const retryTask = store.listTasks().find((task) => task.parentTaskId === roundTask.id)!;
    expect(store.reportFeishuBotOutbound("local", "rt_bot", streamClaim.id, {
      claimToken: streamClaim.claimToken, status: "sent",
    })).toBe(false);
    const retryStream = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true)!;
    expect(retryStream).toMatchObject({ id: streamClaim.id, taskId: retryTask.id, resumeMessageId: "om_live_card" });
    const leaseTime = new Date();
    expect(store.reportFeishuBotOutbound("local", "rt_bot", retryStream.id, {
      claimToken: retryStream.claimToken, status: "streaming",
    }, new Date(leaseTime.getTime() + 60_000))).toBe(true);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(leaseTime.getTime() + 125_000), true)).toBeNull();
    // Expired leases retain the message ID, so a restarted daemon updates the same card.
    const recovered = store.claimFeishuBotOutbound("local", "rt_bot", new Date(leaseTime.getTime() + 185_000), true)!;
    expect(recovered).toMatchObject({ id: streamClaim.id, resumeMessageId: "om_live_card" });
    expect(recovered.claimToken).not.toBe(retryStream.claimToken);
    expect(store.reportFeishuBotOutbound("local", "rt_bot", recovered.id, {
      claimToken: recovered.claimToken, status: "failed", error: "retry test delivery",
    }, new Date(leaseTime.getTime() - 60_000))).toBe(true);
    expect(retryTask).toMatchObject({ status: "queued", chatSessionId: inbound.chatSessionId });
    expect(store.claimTask("rt_bot")?.id).toBe(retryTask.id);
    const retryWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(retryTask.id)!);
    expect(retryWire.bound_issue_updates).toEqual([
      expect.stringContaining("The implementation and migration are complete."),
    ]);
    store.startTask(retryTask.id);
    store.completeTask(retryTask.id, {
      output: "MUL work is complete and ready for review.",
      sessionId: "sess_round_push_chat",
    });

    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({
      delivered: 0,
      dropped: 0,
    });

    store.reportFeishuBotRuntimeStatus("local", "rt_bot", {
      appliedRevision: config.revision,
      state: "online",
    });
    const firstClaim = store.claimFeishuBotOutbound("local", "rt_bot")!;
    expect(firstClaim).toMatchObject({
      chatId: "oc_round_push",
      threadId: "omt_round_push",
      replyToMessageId: "om_round_push_1",
      body: "MUL work is complete and ready for review.",
      bodyOrigin: "agent",
    });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toBeNull();

    const failedAt = new Date();
    expect(store.reportFeishuBotOutbound("local", "rt_bot", firstClaim.id, {
      claimToken: firstClaim.claimToken,
      status: "failed",
      error: "temporary network failure",
    }, failedAt)).toBe(true);
    const retryClaim = store.claimFeishuBotOutbound(
      "local",
      "rt_bot",
      new Date(failedAt.getTime() + 60_000),
    )!;
    expect(retryClaim.id).toBe(firstClaim.id);
    expect(retryClaim.idempotencyKey).toBe(firstClaim.idempotencyKey);
    expect(retryClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(store.reportFeishuBotOutbound("local", "rt_bot", retryClaim.id, {
      claimToken: retryClaim.claimToken,
      status: "sent",
      externalMessageId: "om_proactive_result",
    })).toBe(true);
    expect(store.claimFeishuBotOutbound("local", "rt_bot", new Date(Date.now() + 60_000))).toBeNull();

    const failedLeader = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "This round will fail.",
    });
    expect(store.claimTask("rt_issue_workspace")?.id).toBe(failedLeader.id);
    store.startTask(failedLeader.id);
    const countBeforeFailure = store.listTasks().length;
    store.failTask(failedLeader.id, {
      error: "final failure",
      failureReason: "agent_error",
    });
    expect(store.listTasks()).toHaveLength(countBeforeFailure);
  });

  it("steers an existing inbound Chat task instead of creating a second round task", () => {
    const { store, agent, config } = scaffold();
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_busy:thread:omt_busy",
      externalMessageId: "om_busy_1",
      replyToMessageId: "om_busy_1",
      chatId: "oc_busy",
      threadId: "omt_busy",
      text: "I am already waiting for a response.",
    });
    const issue = store.createIssue({ title: "Busy Feishu topic", workspaceId: "local" });
    store.updateChatSession(inbound.chatSessionId, { issueId: issue.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const leaderTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Finish the Issue round.",
    });
    const taskCount = store.listTasks().length;

    const created = store.prepareFeishuIssueRoundPushesWithinTransaction({ issue, leaderTask });

    expect(created).toHaveLength(0);
    expect(store.listTasks()).toHaveLength(taskCount);
    expect(store.listPendingTaskSteerMessages(inbound.taskId)).toEqual([
      expect.objectContaining({ content: expect.stringContaining(`completed a work round for ${issue.key}`) }),
    ]);
    store.cancelTask(leaderTask.id);

    expect(store.claimTask("rt_bot")?.id).toBe(inbound.taskId);
    store.startTask(inbound.taskId);
    store.failTask(inbound.taskId, {
      error: "temporary inbound task timeout",
      failureReason: "timeout",
    });
    const retry = store.listTasks().find((task) => task.parentTaskId === inbound.taskId)!;
    expect(store.claimTask("rt_bot")?.id).toBe(retry.id);
    daemonTaskClaimResponse(store, store.getTaskWithAgent(retry.id)!);
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "The steered round is complete." });
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", {
      appliedRevision: config.revision,
      state: "online",
    });
    expect(store.claimFeishuBotOutbound("local", "rt_bot")).toMatchObject({
      body: "The steered round is complete.",
      bodyOrigin: "agent",
      chatId: "oc_busy",
      replyToMessageId: "om_busy_1",
    });
  });

  it("waits for delegated work and the leader return before waking the bound Chat", () => {
    const { store, agent, config } = scaffold();
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_delegated:thread:omt_delegated",
      externalMessageId: "om_delegated_1",
      replyToMessageId: "om_delegated_1",
      chatId: "oc_delegated",
      threadId: "omt_delegated",
      senderUnionId: "on_owner",
      text: "Create and track the delegated work.",
    });
    store.cancelTask(inbound.taskId);
    const teammate = store.createAgent({ name: "Teammate", provider: "codex", workspaceId: "local" });
    const squad = store.createSquad({
      name: "Delivery Squad",
      workspaceId: "local",
      leaderId: agent.id,
      memberIds: [teammate.id],
    });
    const issue = store.createIssue({
      title: "Delegated Feishu round",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    store.updateChatSession(inbound.chatSessionId, { issueId: issue.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const leaderTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Delegate and review the work.",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(leaderTask.id);
    store.startTask(leaderTask.id);
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      taskId: leaderTask.id,
      body: `Please implement this [@Teammate](mention://agent/${teammate.id})`,
    });
    const teammateTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === teammate.id)!;
    const baselineChatTaskCount = store.listTasks().filter((task) => task.chatSessionId === inbound.chatSessionId).length;

    store.completeTask(leaderTask.id, { output: "Delegated; waiting for implementation." });
    expect(store.listTasks().filter((task) => task.chatSessionId === inbound.chatSessionId)).toHaveLength(baselineChatTaskCount);
    expect(store.claimTask("rt_bot")?.id).toBe(teammateTask.id);
    store.startTask(teammateTask.id);
    store.completeTask(teammateTask.id, { output: "Implementation complete." });
    expect(store.listTasks().filter((task) => task.chatSessionId === inbound.chatSessionId)).toHaveLength(baselineChatTaskCount);

    const leaderReturn = store.listTasksForIssue(issue.id).find((task) =>
      task.agentId === agent.id && task.parentTaskId === teammateTask.id
    )!;
    expect(store.claimTask("rt_bot")?.id).toBe(leaderReturn.id);
    store.startTask(leaderReturn.id);
    store.completeTask(leaderReturn.id, { output: "Reviewed the implementation; this round is complete." });

    const proactive = store.listTasks().filter((task) =>
      task.chatSessionId === inbound.chatSessionId && task.status === "queued"
    );
    expect(proactive).toHaveLength(1);
    expect(proactive[0]?.prompt).toContain(`completed a work round for ${issue.key}`);
  });

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
    const taskCountBeforeIssueUpdate = store.listTasks().length;
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "member_reviewer",
      body: "The Feishu reviewer approved the bound Issue.",
    });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({
      delivered: 1,
      dropped: 0,
    });
    expect(store.listTasks()).toHaveLength(taskCountBeforeIssueUpdate);

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
    expect(secondTask.holdsWorkspace).toBe(false);
    expect(store.getTaskWithAgent(secondTask.id)?.repos).toEqual([]);
    const secondWire = daemonTaskClaimResponse(store, secondTask);
    expect((secondWire.session_projection as { mode?: string } | undefined)?.mode).toBe("delta");
    const secondPrompt = buildTaskPrompt({
      ...secondTask,
      sessionProjection: secondWire.session_projection,
      chatMessage: secondWire.chat_message,
      boundIssueUpdates: secondWire.bound_issue_updates,
      boundIssueUpdatesOmittedCount: secondWire.bound_issue_updates_omitted_count,
    } as any);

    expect(secondPrompt).toContain(`## Issue\nKey: ${issue.key}`);
    expect(secondPrompt).toContain("## Bound Issue Updates");
    expect(secondPrompt).toContain("The Feishu reviewer approved the bound Issue.");
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

  it("starts a fresh Chat Session when a group route switches Agent", () => {
    const { store, agent, config } = scaffold();
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_routed:thread:omt_routed",
      externalMessageId: "om_routed_1",
      chatType: "group",
      chatId: "oc_routed",
      threadId: "omt_routed",
      text: "before route switch",
    });
    expect(first).toMatchObject({ agentId: agent.id, agentName: "Remi" });
    store.cancelTask(first.taskId);
    const routedAgent = store.createAgent({ name: "Group specialist", provider: "codex", workspaceId: "local" });
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "chat", chatId: "oc_routed", agentId: routedAgent.id },
    ]);

    const second = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_routed:thread:omt_routed",
      externalMessageId: "om_routed_2",
      chatType: "group",
      chatId: "oc_routed",
      threadId: "omt_routed",
      text: "after route switch",
    });
    expect(second).toMatchObject({ agentId: routedAgent.id, agentName: "Group specialist" });
    expect(second.chatSessionId).not.toBe(first.chatSessionId);
    expect(store.getTask(second.taskId)?.agentId).toBe(routedAgent.id);
    expect(store.getFeishuBotConfig("local")?.revision).toBe(config.revision);
  });

  it("keeps one Issue round push on the newest binding after a route switch", () => {
    const { store, agent, config } = scaffold();
    const externalSessionKey = "oc_round_route:thread:omt_round_route";
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey,
      externalMessageId: "om_round_route_1",
      chatType: "group",
      chatId: "oc_round_route",
      threadId: "omt_round_route",
      replyToMessageId: "om_round_route_1",
      text: "before route switch",
    });
    store.cancelTask(first.taskId);
    const issue = store.createIssue({
      title: "Routed round push",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.updateChatSession(first.chatSessionId, { issueId: issue.id });

    const routedAgent = store.createAgent({ name: "Current group Agent", provider: "codex", workspaceId: "local" });
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "chat", chatId: "oc_round_route", agentId: routedAgent.id },
    ]);
    const second = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey,
      externalMessageId: "om_round_route_2",
      chatType: "group",
      chatId: "oc_round_route",
      threadId: "omt_round_route",
      replyToMessageId: "om_round_route_2",
      text: "after route switch",
    });
    store.cancelTask(second.taskId);
    store.updateChatSession(second.chatSessionId, { issueId: issue.id });
    db!.run(
      "UPDATE multiremi_feishu_bot_chat_bindings SET updated_at = ? WHERE chat_session_id = ?",
      ["2026-09-09T00:00:00.000Z", first.chatSessionId],
    );
    db!.run(
      "UPDATE multiremi_feishu_bot_chat_bindings SET updated_at = ? WHERE chat_session_id = ?",
      ["2026-09-09T00:00:01.000Z", second.chatSessionId],
    );

    store.registerRuntime({
      id: "rt_issue_workspace",
      name: "issue-codex",
      provider: "codex",
      workspaceId: "local",
    });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: "rt_issue_workspace",
      rootPath: "/tmp/MUL-routed-round-push",
      branchName: `agent/${issue.key}`,
      status: "ready",
      repos: [],
    });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const leaderTask = store.createSessionTask(session.id, {
      agentId: agent.id,
      prompt: "Complete the routed round.",
    });
    expect(store.claimTask("rt_issue_workspace")?.id).toBe(leaderTask.id);
    store.startTask(leaderTask.id);
    store.completeTask(leaderTask.id, { output: "Round complete." });

    const roundTasks = store.listTasks().filter((task) =>
      task.status === "queued" && [first.chatSessionId, second.chatSessionId].includes(task.chatSessionId ?? "")
    );
    expect(roundTasks).toHaveLength(1);
    expect(roundTasks[0]).toMatchObject({
      agentId: routedAgent.id,
      chatSessionId: second.chatSessionId,
    });
    expect(db!.query(
      `SELECT b.chat_session_id FROM multiremi_feishu_bot_round_pushes r
       JOIN multiremi_feishu_bot_chat_bindings b ON b.id = r.binding_id
       WHERE r.leader_task_id = ?`,
    ).all(leaderTask.id)).toEqual([{ chat_session_id: second.chatSessionId }]);
  });

  it("assigns an automatically created group Issue to the routed Agent", () => {
    const { store, config } = scaffold();
    const routedAgent = store.createAgent({ name: "Issue worker", provider: "codex", workspaceId: "local" });
    store.updateWorkspace("local", {
      settings: { issueTopics: { enabled: true, chatId: "oc_issues" } },
    });
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "chat", chatId: "oc_issues", agentId: routedAgent.id },
    ]);

    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_issues:thread:omt_issue",
      externalMessageId: "om_issue_route",
      chatType: "group",
      chatId: "oc_issues",
      threadId: "omt_issue",
      senderUnionId: "on_owner",
      text: "Implement routed Issue work",
    });
    const chat = store.getChatSession(submitted.chatSessionId)!;
    expect(submitted.agentId).toBe(routedAgent.id);
    expect(store.getIssue(chat.issueId!)).toMatchObject({
      assigneeType: "agent",
      assigneeId: routedAgent.id,
    });
  });

  it("reports the bound Chat and latest canonical Task, then clears it on /new", () => {
    const { store, agent, config } = scaffold();
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
        agentId: agent.id,
        agentName: "Remi",
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
      .toEqual({ chatSessionId: null, agentId: null, agentName: null, task: null });
  });

  it("cancels and resets every routed binding for one Feishu conversation", () => {
    const { store, config } = scaffold();
    const externalSessionKey = "oc_reset_all:thread:omt_reset_all";
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey,
      externalMessageId: "om_reset_all_1",
      chatType: "group",
      chatId: "oc_reset_all",
      threadId: "omt_reset_all",
      text: "old Agent task",
    });
    const routedAgent = store.createAgent({ name: "New Agent", provider: "codex", workspaceId: "local" });
    store.replaceFeishuBotAgentRoutes("local", [
      { scope: "chat", chatId: "oc_reset_all", agentId: routedAgent.id },
    ]);
    const second = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey,
      externalMessageId: "om_reset_all_2",
      chatType: "group",
      chatId: "oc_reset_all",
      threadId: "omt_reset_all",
      text: "new Agent task",
    });
    db!.run(
      "UPDATE multiremi_feishu_bot_chat_bindings SET updated_at = ? WHERE chat_session_id = ?",
      ["2026-09-09T00:00:00.000Z", first.chatSessionId],
    );
    db!.run(
      "UPDATE multiremi_feishu_bot_chat_bindings SET updated_at = ? WHERE chat_session_id = ?",
      ["2026-09-09T00:00:01.000Z", second.chatSessionId],
    );
    expect(store.inspectFeishuBotSession("local", "rt_bot", config.revision, externalSessionKey))
      .toMatchObject({ chatSessionId: second.chatSessionId, agentId: routedAgent.id });

    expect(store.cancelFeishuBotSessionTask("local", "rt_bot", config.revision, externalSessionKey))
      .toBe(second.taskId);
    expect(store.getTask(first.taskId)?.status).toBe("cancelled");
    expect(store.getTask(second.taskId)?.status).toBe("cancelled");
    expect(store.resetFeishuBotSession("local", "rt_bot", config.revision, externalSessionKey)).toBe(true);
    expect(store.inspectFeishuBotSession("local", "rt_bot", config.revision, externalSessionKey))
      .toEqual({ chatSessionId: null, agentId: null, agentName: null, task: null });
    const archivedBindings = db!.query(
      `SELECT id, external_session_key FROM multiremi_feishu_bot_chat_bindings
       WHERE workspace_id = 'local' AND chat_id = ?`,
    ).all("oc_reset_all") as Array<{ id: string; external_session_key: string }>;
    expect(archivedBindings).toHaveLength(2);
    for (const binding of archivedBindings) {
      expect(binding.external_session_key).toBe(`${externalSessionKey}:closed:${binding.id}`);
    }
  });
});
