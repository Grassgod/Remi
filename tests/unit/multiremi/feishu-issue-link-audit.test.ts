import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function scaffold() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Topic", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_audit", name: "Audit", provider: "codex", workspaceId: "local" });
  store.heartbeatRuntime("rt_audit", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id, runtimeId: "rt_audit", appId: "cli_audit", appSecretOp: "set",
    appSecret: "fixture-only", senderAccessPolicy: "agent", domain: "feishu", enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_audit", { appliedRevision: config.revision, state: "online" });
  const input = {
    revision: config.revision, externalSessionKey: "oc_legacy:thread:om_root", externalMessageId: "om_old",
    chatId: "oc_legacy", threadId: "om_root", chatType: "group" as const, senderOpenId: "ou_owner", text: "Existing conversation",
  };
  const first = store.submitFeishuBotMessage("local", "rt_audit", input);
  store.cancelTask(first.taskId);
  const issue = store.createIssue({ title: "Legacy Issue", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
  const binding = db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?")
    .get(first.chatSessionId)! as Record<string, string>;
  const channel = store.upsertAgentChatNotificationChannel({
    workspaceId: "local", chatSessionId: first.chatSessionId, enabled: true, name: "Original subscription",
  });
  const snapshot = JSON.stringify(db!.query("SELECT * FROM multiremi_notification_channels WHERE id = ?").get(channel.id));
  store.deleteAgentChatNotificationChannel(first.chatSessionId);
  db!.run(`INSERT INTO multiremi_feishu_bot_issue_link_audit
    (binding_id, workspace_id, issue_id, audited_at, reason, binding_snapshot, channel_snapshot)
    VALUES (?, 'local', ?, ?, 'unproven_ownership', ?, ?)`,
  [binding.id, issue.id, new Date().toISOString(), JSON.stringify({ ...binding, issue_id: issue.id }), snapshot]);
  // These records would have been included by the removed catch-up projection.
  store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "LEGACY_PRIVATE_COMMENT" });
  const sourceTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Legacy work", holdsWorkspace: false });
  db!.run("UPDATE multiremi_tasks SET status = 'completed', completed_at = ?, result = ? WHERE id = ?",
    [new Date().toISOString(), "SYNTHETIC_SECRET_RESULT /internal/legacy/work", sourceTask.id]);
  const audit = db!.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = ?").get(binding.id);
  return { store, agent, issue, binding, input, first, audit };
}

describe("Feishu Issue link migration audit is passive", () => {
  for (const chatType of ["group", "p2p"] as const) {
    it(`does not restore Issue ownership, subscription or catch-up after a ${chatType} message or restart`, () => {
      const { store, input, first, binding, audit } = scaffold();
      const next = { ...input, chatType, externalMessageId: "om_new", text: "Continue this conversation" };
      const result = store.submitFeishuBotMessage("local", "rt_audit", next);
      expect(store.getTask(result.taskId)?.issueId).toBeNull();
      expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).issueId).toBeNull();
      expect(store.getAgentChatNotificationChannel(first.chatSessionId)).toBeNull();
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries").all()).toEqual([]);
      expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000)).delivered).toBe(0);
      const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(result.taskId)!);
      expect(wire).not.toHaveProperty("issue");
      expect(wire.bound_issue_updates ?? []).toEqual([]);
      expect(JSON.stringify(wire)).not.toContain("LEGACY_PRIVATE_COMMENT");
      expect(JSON.stringify(wire)).not.toContain("SYNTHETIC_SECRET_RESULT");
      expect(store.listChatMessages(first.chatSessionId).some(message => message.role === "system")).toBe(false);
      const restarted = new MultiremiStore(db!);
      expect(restarted.submitFeishuBotMessage("local", "rt_audit", next).duplicate).toBe(true);
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = ?").get(binding.id)).toEqual(audit);
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries").all()).toEqual([]);
    });
  }

  it("uses the ordinary group auto-create path instead of resurrecting an audited Issue", () => {
    const { store, input, issue, binding, audit } = scaffold();
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: input.chatId } } });
    const result = store.submitFeishuBotMessage("local", "rt_audit", {
      ...input, externalMessageId: "om_new_group", text: "A new group request",
    });
    const currentIssue = store.getTask(result.taskId)?.issueId;
    expect(currentIssue).toBeTruthy();
    expect(currentIssue).not.toBe(issue.id);
    expect(store.listIssues()).toHaveLength(2);
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_issue_link_audit WHERE binding_id = ?").get(binding.id)).toEqual(audit);
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries").all()).toEqual([]);
  });

  it("accepts explicit maintenance restoration through the live binding without reading audit or replaying history", () => {
    const { store, input, issue, binding, first } = scaffold();
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE id = ?", [issue.id, binding.id]);
    // Runtime must not require this migration-only table even for a restored topic.
    db!.exec("DROP TABLE multiremi_feishu_bot_issue_link_audit");
    const result = store.submitFeishuBotMessage("local", "rt_audit", { ...input, externalMessageId: "om_restored" });
    expect(store.getTask(result.taskId)?.issueId).toBe(issue.id);
    expect(store.getAgentChatNotificationChannel(first.chatSessionId)).toBeNull();
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries").all()).toEqual([]);
    expect(store.listChatMessages(first.chatSessionId).some(message => message.role === "system")).toBe(false);
  });
});
