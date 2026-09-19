import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "@multiremi/store/migrations.js";
import { seedLegacyChatIssueClassificationFixture } from "./chat-issue-migration-fixture.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import type { IncomingMessage, TaskStreamMeta } from "@connectors/base.js";
import { createFeishuTaskHandler } from "../../../apps/remi/cli/multiremi.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

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

function scaffold(provider: "claude" | "codex" = "codex") {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_sso_owner",
    feishuUnionId: "on_owner",
    email: owner.email,
    name: "Workspace Owner",
  });
  const agent = store.createAgent({ name: "Remi", provider, workspaceId: "local" });
  store.registerRuntime({
    id: "rt_bot",
    name: provider,
    provider,
    workspaceId: "local",
    daemonId: "n37-066-008-hehuajie",
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_bot",
    appId: "cli_test",
    senderAccessPolicy: "allowlist",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  return { store, agent, config };
}

describe("Feishu bot standard Task bridge", () => {
  it("hands an in-flight card to the new connector after the old Runtime lease expires", () => {
    const { store, agent, config } = scaffold();
    store.registerRuntime({ id: "rt_next", name: "New host", provider: "codex", workspaceId: "local",
      daemonId: "another-machine" });
    store.heartbeatRuntime("rt_next", { supportsFeishuBotConfig: true });
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision, externalSessionKey: "oc_handover", chatType: "p2p", chatId: "oc_handover",
      externalMessageId: "om_handover", senderUnionId: "on_owner", deliveryMode: "native_cot_v1",
      text: "Keep answering while the connector moves",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(inbound.taskId);
    store.startTask(inbound.taskId);
    const started = new Date();
    const at = (seconds: number) => new Date(started.getTime() + seconds * 1_000);
    const original = store.claimFeishuBotOutbound("local", "rt_bot", started, true, true)!;
    expect(original.taskId).toBe(inbound.taskId);
    expect(store.reportFeishuBotOutbound("local", "rt_bot", original.id, {
      claimToken: original.claimToken, status: "streaming", externalMessageId: "om_handover_card",
    }, started)).toBe(true);

    const moved = store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId: "rt_next", appId: config.appId,
      appSecretOp: "keep", domain: "feishu", enabled: true,
    });
    expect(store.feishuBotDirectiveForRuntime("local", "rt_next")).toMatchObject({
      desired_state: "stopped", config_available: false,
    });
    expect(store.reportFeishuBotOutbound("local", "rt_bot", original.id, {
      claimToken: original.claimToken, status: "sent", externalMessageId: "om_handover_card",
    }, at(1))).toBe(false);
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "stopped" });
    expect(store.feishuBotDirectiveForRuntime("local", "rt_next")).toMatchObject({
      desired_state: "running", config_available: true,
    });
    store.reportFeishuBotRuntimeStatus("local", "rt_next", { appliedRevision: moved.revision, state: "online" });
    // Moving the connector does not interrupt execution on the original machine.
    expect(store.getTask(inbound.taskId)).toMatchObject({ status: "running", runtimeId: "rt_bot" });
    store.completeTask(inbound.taskId, { output: "Answer survives the handover", sessionId: "sess_handover" });
    expect(store.claimFeishuBotOutbound("local", "rt_next", at(119), true, true)).toBeNull();
    const resumed = store.claimFeishuBotOutbound("local", "rt_next", at(121), true, true)!;
    expect(resumed).toMatchObject({ id: original.id, taskId: inbound.taskId, resumeMessageId: "om_handover_card" });
    expect(resumed.claimToken).not.toBe(original.claimToken);
    expect(store.reportFeishuBotOutbound("local", "rt_next", resumed.id, {
      claimToken: original.claimToken, status: "sent",
    }, at(122))).toBe(false);
    expect(store.reportFeishuBotOutbound("local", "rt_next", resumed.id, {
      claimToken: resumed.claimToken, status: "sent", externalMessageId: resumed.resumeMessageId,
    }, at(122))).toBe(true);
    expect(store.claimFeishuBotOutbound("local", "rt_next", at(250), true, true)).toBeNull();
  });

  for (const [from, to, explicitModel] of [
    ["claude", "codex", "gpt-5.6-sol"],
    ["codex", "claude", "claude-opus-5"],
  ] as const) {
    for (const model of ["", explicitModel]) {
      for (const previousTurn of ["none", "queued", "completed"] as const) {
        it(`schedules ${from} -> ${to} with model=${model || "default"} and ${previousTurn} prior turn`, () => {
          const { store, agent, config } = scaffold(from);
          store.registerRuntime({ id: "rt_executor", name: to, provider: to, workspaceId: "local",
            daemonId: "another-machine",
            models: [{ id: explicitModel, label: explicitModel, provider: to, default: true }] });
          store.reportFeishuBotRuntimeStatus("local", "rt_bot", {
            appliedRevision: config.revision, state: "online",
          });
          const submit = (id: string) => store.submitFeishuBotMessage("local", "rt_bot", {
            revision: config.revision, externalSessionKey: "oc_provider_switch", chatType: "p2p",
            chatId: "oc_provider_switch", externalMessageId: id, senderUnionId: "on_owner",
            deliveryMode: "native_cot_v1", text: `Message ${id}`,
          });
          const previous = previousTurn === "none" ? null : submit("om_before");
          if (previousTurn === "completed") {
            expect(store.claimTask("rt_bot")?.id).toBe(previous!.taskId);
            store.startTask(previous!.taskId);
            store.completeTask(previous!.taskId, { output: "Previous answer", sessionId: "sess_previous" });
            const reply = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true)!;
            expect(store.reportFeishuBotOutbound("local", "rt_bot", reply.id, {
              claimToken: reply.claimToken, status: "sent", externalMessageId: "om_previous_reply",
            })).toBe(true);
          }
          store.updateAgent(agent.id, { provider: to, model });
          if (previousTurn === "queued") {
            // Old code could create a transport-pinned Task after the Agent
            // changed provider. Reproduce that stored state across an upgrade.
            db!.run("UPDATE multiremi_tasks SET runtime_id = 'rt_bot' WHERE id = ?", [previous!.taskId]);
          }
          const next = submit("om_after");
          if (previous) expect(next.chatSessionId).toBe(previous.chatSessionId);
          if (previousTurn === "queued") expect(next.taskId).toBe(previous!.taskId);
          expect(store.claimTask("rt_bot")).toBeNull();
          const claimed = store.claimTask("rt_executor");
          expect(claimed?.id).toBe(next.taskId);
          expect(claimed?.sessionId).toBeNull();
          expect(claimed?.agent?.provider).toBe(to);
          store.startTask(next.taskId);
          store.consumeTaskSteerMessages(next.taskId, store.listTaskSteerMessages(next.taskId).map(message => message.id));
          store.completeTask(next.taskId, { output: "Answer after switch", sessionId: "sess_new_provider" });
          // Execution can move machines; the configured connector still owns replies.
          expect(store.claimFeishuBotOutbound("local", "rt_executor", undefined, true, true)).toBeNull();
          const reply = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true)!;
          expect(reply.taskId).toBe(next.taskId);
          expect(store.reportFeishuBotOutbound("local", "rt_bot", reply.id, {
            claimToken: reply.claimToken, status: "sent", externalMessageId: "om_new_reply",
          })).toBe(true);
          const followup = submit("om_followup");
          expect(store.claimTask("rt_executor")).toMatchObject({
            id: followup.taskId, sessionId: "sess_new_provider",
          });
        });
      }
    }
  }

  for (const path of ["p2p", "group", "canonical-topic"] as const) {
    it(`rejects shared Chat binding creation and rolls back ${path}`, () => {
      const { store, config } = scaffold();
      const issue = store.createIssue({ title: "Binding guard", workspaceId: "local" });
      store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
      store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_guard" } } });
      // Simulate an abnormal writer occupying the newly created Chat. The
      // production transaction must reject the second binding and roll back.
      db!.exec(`CREATE TRIGGER occupy_new_chat AFTER INSERT ON multiremi_chat_sessions BEGIN
        INSERT INTO multiremi_feishu_bot_chat_bindings
          (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
        VALUES ('conflicting_binding', 'other_workspace', 'other_app', NEW.agent_id,
          'occupied', NEW.id, NEW.created_at, NEW.updated_at);
      END`);
      const invoke = () => path === "canonical-topic"
        ? store.prepareFeishuIssueTopicWithinTransaction(issue)
        : store.submitFeishuBotMessage("local", "rt_bot", {
          revision: config.revision, externalSessionKey: `guard_${path}`, chatType: path,
          chatId: "oc_guard", externalMessageId: "om_guard", senderUnionId: "on_owner",
          senderOpenId: "ou_requester", text: "Should roll back",
        });
      expect(invoke).toThrow(/Cannot create binding .*: Chat .* already has binding conflicting_binding/);
      for (const table of ["multiremi_chat_sessions", "multiremi_feishu_bot_chat_bindings",
        "multiremi_feishu_bot_deliveries", "multiremi_feishu_bot_outbound_deliveries", "multiremi_tasks"]) {
        expect(db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_issues").get()).toEqual({ count: 1 });
    });
  }

  for (const tableForeignKey of [false, true]) {
    it(`cold-starts p2p sharing a retained group binding after migration (table FK=${tableForeignKey})`, () => {
      const { store } = scaffold();
      seedLegacyChatIssueClassificationFixture(db!, tableForeignKey);
      const chatId = "chat_classification_mixed_bindings";
      const fingerprint = createHash("sha256").update("[]").digest("hex");
      db!.run(`UPDATE multiremi_chat_sessions SET session_execution_fingerprint = ?,
        session_id = 'provider_issue_A', work_dir = '/work/issue-A' WHERE id = ?`, [fingerprint, chatId]);
      // No outstanding task is needed to trigger the provider reset.
      db!.run("UPDATE multiremi_tasks SET status = 'completed'");
      store.registerRuntime({ id: "rt_legacy", name: "Original machine", provider: "codex", workspaceId: "local" });
      store.heartbeatRuntime("rt_legacy", { supportsFeishuBotConfig: true });
      const config = store.upsertFeishuBotConfig("local", {
        agentId: "agt_chat_migration", runtimeId: "rt_legacy", appId: "cli_migration",
        senderAccessPolicy: "allowlist", appSecretOp: "set", appSecret: APP_SECRET,
        domain: "feishu", enabled: true,
      });
      runMigrations(db!);
      expect(db!.query("SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?")
        .get(`fcb_${chatId}`)).toEqual({ issue_id: "iss_classification_mixed_bindings" });
      expect(db!.query("SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = 'fcb_mixed_private'")
        .get()).toEqual({ issue_id: null });
      const inbound = store.submitFeishuBotMessage("local", "rt_legacy", {
        revision: config.revision, externalSessionKey: "oc_mixed_private", chatType: "p2p",
        chatId: "oc_mixed_private", externalMessageId: "om_after_mixed_migration",
        senderOpenId: "ou_requester", senderUnionId: "on_owner", text: "Private question",
      });
      expect(inbound.chatSessionId).toBe(chatId);
      const task = store.getTaskWithAgent(inbound.taskId)!;
      expect(task.issueId).toBeNull();
      expect(task.sessionId).toBeNull();
      expect(task.runtimeId).toBeNull();
      expect(task.workDir).toBeNull();
      const wire = daemonTaskClaimResponse(store, task);
      expect(wire.issue).toBeUndefined();
      expect(wire.session_id).toBeUndefined();
      expect(wire.prior_session_id).toBeUndefined();
      expect(wire.runtime_id).toBe(""); // Existing wire representation for an unassigned runtime.
      expect(wire.work_dir).toBeUndefined();
      expect(wire.prior_work_dir).toBeUndefined();
      // The private task cannot consume the retained topic's directory affinity.
      expect(store.getChatSession(chatId)).toMatchObject({
        sessionId: null, sessionProvider: null, sessionExecutionFingerprint: null,
        workDir: "/work/issue-A", sessionRuntimeId: "rt_legacy",
      });
      const topic = store.createTask({ agentId: "agt_chat_migration", chatSessionId: chatId,
        issueId: "iss_classification_mixed_bindings", prompt: "Group continuation" });
      expect(topic).toMatchObject({ runtimeId: "rt_legacy", workDir: "/work/issue-A" });
      store.cancelTask(topic.id);
      // Claim refresh must not restore the shared topic's affinity either.
      const claimed = store.claimTask("rt_bot")!;
      expect(claimed.id).toBe(task.id);
      expect(claimed.workDir).toBeNull();
      const claimedWire = daemonTaskClaimResponse(store, claimed);
      expect(claimedWire.runtime_id).toBe("rt_bot");
      expect(claimedWire.work_dir).toBeUndefined();
      expect(claimedWire.prior_work_dir).toBeUndefined();
    });
  }

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
      expect(delivery).toMatchObject({ chatId: scenario.chatId,
        replyToMessageId: scenario.chatType === "p2p" ? null : scenario.messageId,
        receiptMessageIds: [scenario.messageId],
        interactionOpenId: "ou_requester", presentation: { version: "native_cot_v1" } });
      expect(store.getTaskWithAgent(delivery.taskId!)?.agent?.name).toBe(scenario.expected);
      expect(delivery.mention?.resolvedOpenId).toBe(scenario.chatType === "group" ? "ou_requester" : null);
    }
  });

  it("keeps successive private results in the same chat binding, including input from an older daemon", () => {
    const { store, config } = scaffold();
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
    const input = { revision: config.revision, externalSessionKey: "ou_private", chatType: "p2p" as const,
      chatId: "oc_private", senderOpenId: "ou_requester", senderUnionId: "on_owner",
      deliveryMode: "native_cot_v1" as const, text: "Hello" };
    const first = store.submitFeishuBotMessage("local", "rt_bot", {
      ...input, externalMessageId: "om_first", replyToMessageId: "om_first",
    });
    const delivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true)!;
    expect(delivery).toMatchObject({ taskId: first.taskId, threadId: null, replyToMessageId: null });
    store.cancelTask(first.taskId);
    expect(store.reportFeishuBotOutbound("local", "rt_bot", delivery.id, {
      claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_result",
    })).toBe(true);
    expect(db!.query("SELECT external_session_key, thread_id, reply_to_message_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?")
      .get(first.chatSessionId)).toMatchObject({ external_session_key: "ou_private", thread_id: null, reply_to_message_id: null });

    const second = store.submitFeishuBotMessage("local", "rt_bot", { ...input, externalMessageId: "om_second" });
    expect(second.chatSessionId).toBe(first.chatSessionId);
    expect(second.taskId).not.toBe(first.taskId);
    const nextDelivery = store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true)!;
    expect(nextDelivery).toMatchObject({ taskId: second.taskId, threadId: null, replyToMessageId: null,
      receiptMessageIds: ["om_second"] });
  });

  it("preserves an explicit private topic instead of moving its reply to the main chat", () => {
    const { store, config } = scaffold();
    store.reportFeishuBotRuntimeStatus("local", "rt_bot", { appliedRevision: config.revision, state: "online" });
    store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision, externalSessionKey: "oc_private:thread:om_root", chatType: "p2p",
      chatId: "oc_private", threadId: "om_root", externalMessageId: "om_followup",
      senderUnionId: "on_owner", deliveryMode: "native_cot_v1", text: "Follow up here",
    });
    expect(store.claimFeishuBotOutbound("local", "rt_bot", undefined, true, true))
      .toMatchObject({ threadId: "om_root", replyToMessageId: "om_followup" });
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
    bindFeishuTopicFixture(store, db!, inbound.chatSessionId, issue.id);
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

    // The reply/retry scenario below expects a specific executor. Express that
    // as Agent placement now that the transport does not impose it.
    store.updateAgent(agent.id, { runtimeId: "rt_bot" });
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

    // Resume normal placement for the next Issue round on its workspace host.
    store.updateAgent(agent.id, { runtimeId: null });
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
    const initial = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_busy:thread:omt_busy",
      externalMessageId: "om_busy_seed",
      replyToMessageId: "om_busy_1",
      chatId: "oc_busy",
      threadId: "omt_busy",
      text: "I am already waiting for a response.",
    });
    const issue = store.createIssue({ title: "Busy Feishu topic", workspaceId: "local" });
    store.cancelTask(initial.taskId);
    bindFeishuTopicFixture(store, db!, initial.chatSessionId, issue.id);
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_busy:thread:omt_busy",
      externalMessageId: "om_busy_1",
      replyToMessageId: "om_busy_1",
      chatId: "oc_busy", threadId: "omt_busy", chatType: "group",
      text: "I am already waiting for a response.",
    });
    expect(store.getTask(inbound.taskId)?.issueId).toBe(issue.id);
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

  it("keeps an already-running private user turn separate when an Issue binding appears", () => {
    const { store, agent, config } = scaffold();
    const inbound = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision, externalSessionKey: "oc_new:thread:omt_new",
      externalMessageId: "om_new", replyToMessageId: "om_new", chatId: "oc_new", threadId: "omt_new",
      text: "Ordinary user question",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(inbound.taskId);
    store.startTask(inbound.taskId);
    const issue = store.createIssue({ title: "New Issue binding", workspaceId: "local" });
    bindFeishuTopicFixture(store, db!, inbound.chatSessionId, issue.id);
    const leader = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Issue work" });
    const wakes = store.prepareFeishuIssueRoundPushesWithinTransaction({ issue, leaderTask: leader });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ issueId: issue.id, chatSessionId: inbound.chatSessionId });
    expect(store.listPendingTaskSteerMessages(inbound.taskId)).toEqual([]);
    const original = store.getTaskWithAgent(inbound.taskId)!;
    expect(original.issueId).toBeNull();
    expect(original.prompt).toBe("Ordinary user question");
    expect(daemonTaskClaimResponse(store, original).bound_issue).toBeUndefined();
    store.completeTask(inbound.taskId, { output: "Ordinary user reply" });
    expect(store.listChatMessages(inbound.chatSessionId).at(-1)?.body).toBe("Ordinary user reply");
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
    bindFeishuTopicFixture(store, db!, inbound.chatSessionId, issue.id);
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
      externalSessionKey: "oc_chat_delta:thread:omt_delta",
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
    bindFeishuTopicFixture(store, db!, firstSubmission.chatSessionId, issue.id);
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
      externalSessionKey: "oc_chat_delta:thread:omt_delta",
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
      boundIssue: secondWire.bound_issue,
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
    const { store, agent, config } = scaffold();
    // This deduplication fixture exercises an explicitly pinned Agent. The
    // connector no longer supplies task placement for automatically scheduled Agents.
    store.updateAgent(agent.id, { runtimeId: "rt_bot" });
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
      senderAllowed: false,
    });
    const task = store.getTask(first.taskId)!;
    expect(task).toMatchObject({
      chatSessionId: first.chatSessionId,
      runtimeId: "rt_bot",
      prompt: "first message",
      workDir: null,
      requestingUserName: "Owner from Feishu",
      requestingUserProfileDescription: "Source: Feishu personal bot\nThe space owner manages account access in Settings > Integrations > Feishu account allowlist.\nApproval can change during this Chat. Retry the requested action after the owner updates the allowlist; the API checks current access.",
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
    expect(store.listFeishuBotTaskReceiptMessageIds("local", first.taskId)).toEqual(["om_1", "om_2"]);
  });

  it("admits an unknown sender but checks Issue creation against the dynamic allowlist", () => {
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

    expect(submitted.senderAllowed).toBe(false);
    expect(store.getTask(submitted.taskId)).toMatchObject({
      requestingUserName: "External Alice",
      requestingUserProfileDescription: "Source: Feishu personal bot\nThe space owner manages account access in Settings > Integrations > Feishu account allowlist.\nApproval can change during this Chat. Retry the requested action after the owner updates the allowlist; the API checks current access.",
      issueCreationRestricted: false,
    });
    expect(store.isFeishuBotTaskIssueCreationRestricted(submitted.taskId)).toBe(true);
  });

  it("does not use a known Remi identity as an account approval", () => {
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
      senderOpenId: "ou_known_outsider",
      senderUnionId: "on_outsider",
      senderName: "Stale Event Name",
      text: "hello from another workspace",
    });

    expect(submitted.senderAllowed).toBe(false);
    expect(store.getTask(submitted.taskId)).toMatchObject({
      requestingUserName: "Stale Event Name",
      requestingUserProfileDescription: "Source: Feishu personal bot\nThe space owner manages account access in Settings > Integrations > Feishu account allowlist.\nApproval can change during this Chat. Retry the requested action after the owner updates the allowlist; the API checks current access.",
      issueCreationRestricted: false,
    });
    expect(store.isFeishuBotTaskIssueCreationRestricted(submitted.taskId)).toBe(true);
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
    bindFeishuTopicFixture(store, db!, first.chatSessionId, issue.id);

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
    bindFeishuTopicFixture(store, db!, second.chatSessionId, issue.id);
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

    store.submitFeishuBotMessage("local", "rt_bot", { revision: config.revision, externalSessionKey: "oc_discovery",
      externalMessageId: "om_discovery", senderOpenId: "ou_owner", text: "Hello" });
    store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision: config.revision,
      externalSessionKey: "oc_issues:thread:omt_issue",
      externalMessageId: "om_issue_route",
      chatType: "group",
      chatId: "oc_issues",
      threadId: "omt_issue",
      senderOpenId: "ou_owner",
      senderUnionId: "on_owner",
      text: "Implement routed Issue work",
    });
    const chat = store.getChatSession(submitted.chatSessionId)!;
    expect(submitted.agentId).toBe(routedAgent.id);
    expect(store.getIssue(store.getFeishuIssueIdForChatSession(chat.id)!)).toMatchObject({
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
