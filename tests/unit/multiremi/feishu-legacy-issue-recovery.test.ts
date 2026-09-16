import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

let oldEncryptionKey: string | undefined;
beforeEach(() => {
  oldEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});
afterEach(() => {
  if (oldEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = oldEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold(options: { enabled?: boolean; eventTypes?: string[]; noChannel?: boolean } = {}) {
  const store = createLocalStore();
  store.getOrCreateUser({ externalId: "ou_owner", feishuUnionId: "on_owner", email: store.getCurrentUser().email });
  const agent = store.createAgent({ name: "Topic", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_recovery", name: "Recovery", provider: "codex", workspaceId: "local" });
  store.heartbeatRuntime("rt_recovery", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id, runtimeId: "rt_recovery", appId: "cli_recovery", appSecretOp: "set",
    appSecret: "test-legacy-recovery-credential", senderAccessPolicy: "allowlist", domain: "feishu", enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_recovery", { appliedRevision: config.revision, state: "online" });
  const input = {
    revision: config.revision, externalSessionKey: "oc_legacy:thread:om_root", externalMessageId: "om_old",
    chatId: "oc_legacy", threadId: "om_root", chatType: "group" as const, senderUnionId: "on_owner", senderOpenId: "ou_owner", text: "Existing topic",
  };
  const first = store.submitFeishuBotMessage("local", "rt_recovery", input);
  store.cancelTask(first.taskId);
  db!.run("UPDATE multiremi_feishu_bot_senders SET allowed = 1 WHERE open_id = 'ou_owner'");
  const issue = store.createIssue({ title: "Existing legacy Issue", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
  const binding = db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?").get(first.chatSessionId)! as Record<string, any>;
  let snapshot: string | null = null;
  if (!options.noChannel) {
    const channel = store.upsertAgentChatNotificationChannel({
      workspaceId: "local", chatSessionId: first.chatSessionId, enabled: options.enabled ?? true, name: "Original subscription",
    });
    db!.run("UPDATE multiremi_notification_channels SET event_types = ?, min_severity = 'warning' WHERE id = ?", [JSON.stringify(options.eventTypes ?? ["*"]), channel.id]);
    snapshot = JSON.stringify(db!.query("SELECT * FROM multiremi_notification_channels WHERE id = ?").get(channel.id));
    store.deleteAgentChatNotificationChannel(first.chatSessionId);
  }
  const replaySince = new Date(Date.now() - 60_000).toISOString();
  db!.run(`INSERT INTO multiremi_feishu_bot_legacy_issue_links
    (binding_id, workspace_id, issue_id, quarantined_at, replay_since, channel_snapshot)
    VALUES (?, 'local', ?, ?, ?, ?)`, [binding.id, issue.id, replaySince, replaySince, snapshot]);
  // A destination that would auto-create a replacement if quarantine were ignored.
  store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_legacy" } } });
  const next = { ...input, externalMessageId: "om_new", text: "Continue the existing Issue" };
  return { store, agent, config, input, next, first, issue, binding, snapshot };
}
function marker(bindingId: unknown) {
  return db!.query("SELECT * FROM multiremi_feishu_bot_legacy_issue_links WHERE binding_id = ?").get(String(bindingId));
}
function outboxes() {
  return db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id LIKE 'fbo_legacy_recovery_%'").all() as Array<Record<string, any>>;
}

describe("quarantined Feishu Issue link recovery", () => {
  it("upgrades a real legacy group association, then recovers it on the next authoritative message", () => {
    const { store, next, issue, binding, first, snapshot } = scaffold();
    db!.run("DELETE FROM multiremi_feishu_bot_legacy_issue_links WHERE binding_id = ?", [binding.id]);
    db!.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT REFERENCES multiremi_issues(id)");
    db!.run("UPDATE multiremi_chat_sessions SET issue_id = ?, session_id = 'old-provider', session_provider = 'codex', session_execution_fingerprint = 'old' WHERE id = ?",
      [issue.id, first.chatSessionId]);
    const original = JSON.parse(snapshot!);
    db!.run(`INSERT INTO multiremi_notification_channels (${Object.keys(original).join(", ")})
      VALUES (${Object.keys(original).map(() => "?").join(", ")})`, Object.values(original) as any[]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = '20260916_chat_issue_decoupling'");
    runMigrations(db! as unknown as SqlDatabase);
    expect(marker(binding.id)).toMatchObject({ issue_id: issue.id, channel_snapshot: snapshot });
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).issueId).toBeNull();
    expect(store.getChatSession(first.chatSessionId)?.sessionId).toBeNull();
    expect(store.getAgentChatNotificationChannel(first.chatSessionId)).toBeNull();
    const recovered = store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(store.getTask(recovered.taskId)?.issueId).toBe(issue.id);
    expect(marker(binding.id)).toBeNull();
    expect(outboxes()).toHaveLength(1);
    expect(store.getChatSession(first.chatSessionId)?.sessionId).toBeNull();
  });

  it("recovers the same group before auto-create, restores subscription and catches up durably without changing the root", () => {
    const { store, next, issue, binding, first } = scaffold();
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Window update" });
    const result = store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(result.chatSessionId).toBe(first.chatSessionId);
    expect(store.getTask(result.taskId)?.issueId).toBe(issue.id);
    expect(store.listIssues()).toHaveLength(1);
    expect(marker(binding.id)).toBeNull();
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).enabled).toBe(true);
    expect(store.getAgentChatNotificationChannel(first.chatSessionId)?.minSeverity).toBe("warning");
    expect(store.getChatSession(first.chatSessionId)?.sessionId).toBeNull();
    expect(outboxes()).toHaveLength(1);
    const delivery = store.claimFeishuBotOutbound("local", "rt_recovery")!;
    expect(delivery.body).toContain("Window update");
    expect(delivery).toMatchObject({ chatId: "oc_legacy", threadId: "om_root", replyToMessageId: "om_new" });
    expect(store.reportFeishuBotOutbound("local", "rt_recovery", delivery.id, {
      claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_catchup",
    })).toBe(true);
    expect(db!.query("SELECT external_session_key, thread_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(binding.id))
      .toEqual({ external_session_key: next.externalSessionKey, thread_id: "om_root" });
    const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(result.taskId)!);
    expect(JSON.stringify(wire.bound_issue_updates)).toContain("Window update");
  });

  it("recovers on a duplicate delivery once and survives restart without another catch-up", () => {
    const { store, input, issue, binding } = scaffold();
    const first = store.submitFeishuBotMessage("local", "rt_recovery", input);
    expect(first.duplicate).toBe(true);
    expect(db!.query("SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(binding.id)).toMatchObject({ issue_id: issue.id });
    expect(outboxes()).toHaveLength(1);
    const restarted = new MultiremiStore(db!);
    expect(restarted.submitFeishuBotMessage("local", "rt_recovery", input).duplicate).toBe(true);
    expect(outboxes()).toHaveLength(1);
    expect(restarted.listChatMessages(first.chatSessionId).filter((message) => message.body.startsWith("Feishu Issue topic restored:"))).toHaveLength(1);
  });

  it("permanently discards threaded p2p legacy ownership and sends no catch-up", () => {
    const { store, input, first, binding } = scaffold();
    const p2p = { ...input, chatType: "p2p" as const };
    store.submitFeishuBotMessage("local", "rt_recovery", p2p);
    expect(marker(binding.id)).toBeNull();
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).issueId).toBeNull();
    store.updateWorkspace("local", { settings: { issueTopics: { enabled: false } } });
    store.submitFeishuBotMessage("local", "rt_recovery", { ...input, externalMessageId: "later" });
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).issueId).toBeNull();
    expect(outboxes()).toHaveLength(0);
  });

  for (const scenario of ["missing-type", "unauthorized-sender", "cross-workspace", "deleted-issue", "malformed-channel"] as const) {
    it(`keeps ${scenario} quarantined without auto-creating a replacement`, () => {
      const { store, next, issue, binding } = scaffold();
      const input = { ...next } as Record<string, unknown>;
      if (scenario === "missing-type") delete input.chatType;
      if (scenario === "unauthorized-sender") input.senderOpenId = "ou_stranger";
      if (scenario === "cross-workspace") db!.run("UPDATE multiremi_feishu_bot_legacy_issue_links SET workspace_id = 'other' WHERE binding_id = ?", [binding.id]);
      if (scenario === "deleted-issue") db!.run("UPDATE multiremi_feishu_bot_legacy_issue_links SET issue_id = 'missing' WHERE binding_id = ?", [binding.id]);
      if (scenario === "malformed-channel") db!.run("UPDATE multiremi_feishu_bot_legacy_issue_links SET channel_snapshot = '{broken' WHERE binding_id = ?", [binding.id]);
      const result = store.submitFeishuBotMessage("local", "rt_recovery", input as any);
      expect(store.getTask(result.taskId)?.issueId).toBeNull();
      expect(marker(binding.id)).not.toBeNull();
      expect(outboxes()).toHaveLength(0);
      expect(store.listIssues().map((value) => value.id)).toEqual([issue.id]);
    });
  }

  it("rejects consecutive wrong destinations without allowing them to rewrite the original binding", () => {
    const { store, next, binding } = scaffold();
    for (const externalMessageId of ["wrong-1", "wrong-2"]) {
      expect(() => store.submitFeishuBotMessage("local", "rt_recovery", { ...next, externalMessageId, chatId: "oc_other" }))
        .toThrow("legacy conversation destination does not match");
      expect(db!.query("SELECT chat_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(binding.id)).toMatchObject({ chat_id: "oc_legacy" });
    }
    expect(marker(binding.id)).not.toBeNull();
    expect(outboxes()).toHaveLength(0);
  });

  it("also rejects thread destination changes before authoritative recovery", () => {
    const { store, next, binding } = scaffold();
    for (const chatType of [undefined, "group"] as const) {
      expect(() => store.submitFeishuBotMessage("local", "rt_recovery", { ...next, chatType, threadId: "om_other" }))
        .toThrow("legacy conversation destination does not match");
      expect(db!.query("SELECT thread_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(binding.id))
        .toEqual({ thread_id: "om_root" });
    }
    expect(marker(binding.id)).not.toBeNull();
  });

  it("does not let an original conversation without a thread acquire a new root while quarantined", () => {
    const { store, next, binding } = scaffold();
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET thread_id = NULL WHERE id = ?", [binding.id]);
    for (const chatType of [undefined, "group"] as const) {
      expect(() => store.submitFeishuBotMessage("local", "rt_recovery", { ...next, chatType, threadId: "om_new_root" }))
        .toThrow("legacy conversation destination does not match");
      expect(db!.query("SELECT thread_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(binding.id))
        .toEqual({ thread_id: null });
    }
    expect(marker(binding.id)).not.toBeNull();
    expect(outboxes()).toHaveLength(0);
  });

  it("replays an unconsumed pre-migration activity from the saved earlier replay boundary", () => {
    const { store, next, issue, binding } = scaffold();
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Earlier unconsumed update" });
    db!.run("UPDATE multiremi_issue_activity SET created_at = ? WHERE issue_id = ? AND type = 'comment_created'",
      [new Date(Date.now() - 30_000).toISOString(), issue.id]);
    db!.run("UPDATE multiremi_feishu_bot_legacy_issue_links SET quarantined_at = ? WHERE binding_id = ?",
      [new Date().toISOString(), binding.id]);
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(String(outboxes()[0]?.body)).toContain("Earlier unconsumed update");
  });

  it("rolls recovery and catch-up back if the remainder of the inbound transaction fails", () => {
    const { store, next, binding, first } = scaffold();
    expect(() => store.submitFeishuBotMessage("local", "rt_recovery", { ...next, attachmentIds: ["invalid-upload"] }))
      .toThrow("attachment does not belong");
    expect(marker(binding.id)).not.toBeNull();
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).issueId).toBeNull();
    expect(store.getAgentChatNotificationChannel(first.chatSessionId)).toBeNull();
    expect(outboxes()).toHaveLength(0);
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(outboxes()).toHaveLength(1);
  });

  it("preserves a disabled subscription exactly and creates none of the catch-up side effects", () => {
    const { store, next, snapshot, first, binding } = scaffold({ enabled: false, eventTypes: ["comment_created"] });
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(db!.query("SELECT * FROM multiremi_notification_channels WHERE id = ?").get(JSON.parse(snapshot!).id)).toEqual(JSON.parse(snapshot!));
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).enabled).toBe(false);
    expect(marker(binding.id)).toBeNull();
    expect(outboxes()).toHaveLength(0);
    expect(store.listChatMessages(first.chatSessionId).some((message) => message.role === "system")).toBe(false);
  });

  it("uses the default topic subscription only when no original channel existed", () => {
    const { store, next, first } = scaffold({ noChannel: true });
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(store.getAgentIssueUpdateSubscription(first.chatSessionId).enabled).toBe(true);
    expect(outboxes()).toHaveLength(1);
  });

  it("bounds catch-up output, counts omitted events, respects filters and exposes only public request messages", () => {
    const { store, next, issue, agent } = scaffold();
    for (let i = 0; i < 13; i++) store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: `entry-${i} ${"a".repeat(500)}` });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Window work", holdsWorkspace: false });
    const pending = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {
      message: "Please approve the reviewed result", toolInput: { sensitive: "MUST_NOT_APPEAR" },
    } });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', completed_at = ?, result = 'Work finished during quarantine' WHERE id = ?", [new Date().toISOString(), task.id]);
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    const body = String(outboxes()[0]?.body);
    expect(body).toContain("entries omitted");
    expect(body).toContain("[truncated]");
    expect(body).toContain("Work finished during quarantine");
    expect(body).toContain(pending.id);
    expect(body).toContain("Please approve the reviewed result");
    expect(body).not.toContain("MUST_NOT_APPEAR");
    expect(body.length).toBeLessThan(20_000);
    expect(body).toContain(`remi issue timeline ${issue.key}`);
    expect(body).toContain("remi task request list");
  });

  it("limits recovery summary to the original event filter", () => {
    const { store, next, issue } = scaffold({ eventTypes: ["comment_created"] });
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Allowed comment" });
    store.updateIssue(issue.id, { title: "Filtered title change" });
    store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(String(outboxes()[0]?.body)).toContain("Allowed comment");
    expect(String(outboxes()[0]?.body)).not.toContain("[title_renamed]");
    expect(String(outboxes()[0]?.body)).not.toContain("Completed work during the interruption:");
  });

  it("steers an already running unbound turn with the catch-up and binds the next turn without resurrecting provider state", () => {
    const { store, next, first, issue } = scaffold();
    const old = store.submitFeishuBotMessage("local", "rt_recovery", { ...next, chatType: undefined, externalMessageId: "untyped" });
    expect(store.claimTask("rt_recovery")?.id).toBe(old.taskId);
    store.startTask(old.taskId);
    const recovered = store.submitFeishuBotMessage("local", "rt_recovery", next);
    expect(recovered.steered).toBe(true);
    expect(store.listTaskSteerMessages(old.taskId).map((message) => message.content).join("\n")).toContain("Feishu Issue topic restored:");
    store.consumeTaskSteerMessages(old.taskId, store.listPendingTaskSteerMessages(old.taskId).map((message) => message.id));
    store.completeTask(old.taskId, { output: "Read the recovery summary" });
    const bound = store.submitFeishuBotMessage("local", "rt_recovery", { ...next, externalMessageId: "after-recovery" });
    expect(store.getTask(bound.taskId)?.issueId).toBe(issue.id);
    expect(store.getChatSession(first.chatSessionId)?.sessionId).toBeNull();
    const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(bound.taskId)!);
    expect(wire.bound_issue_updates ?? []).toEqual([]);
  });

  it("continues Issue updates, round summaries and human-request pushes after recovery without duplicate push records", () => {
    const { store, next, first, issue, agent } = scaffold();
    const resumed = store.submitFeishuBotMessage("local", "rt_recovery", next);
    store.cancelTask(resumed.taskId);
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Update after recovery" });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000)).delivered).toBe(1);
    expect(store.listChatMessages(first.chatSessionId).map((message) => message.body).join("\n")).toContain("Update after recovery");
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Recovered topic work", holdsWorkspace: false });
    const rounds = store.prepareFeishuIssueRoundPushesWithinTransaction({ issue, leaderTask: task });
    expect(rounds).toHaveLength(1);
    expect(store.prepareFeishuIssueRoundPushesWithinTransaction({ issue, leaderTask: task })).toHaveLength(0);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { message: "Choose a direction" } });
    const push = store.prepareFeishuBotHumanRequestPush(request);
    expect(push?.chatSessionId).toBe(first.chatSessionId);
    expect(store.prepareFeishuBotHumanRequestPush(request)?.id).toBe(push!.id);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_round_pushes WHERE issue_id = ?").get(issue.id)).toEqual({ count: 1 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_human_request_pushes WHERE issue_id = ?").get(issue.id)).toEqual({ count: 1 });
  });
});
