import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { seedLegacyChatIssueClassificationFixture } from "./chat-issue-migration-fixture.js";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

type PushKind = "round" | "human" | "inbound" | "attachment";
function scaffold(scenario: "unknown_legacy_group" | "p2p_thread_and_key" | "group_without_thread", kind: PushKind) {
  const store = createLocalStore();
  seedLegacyChatIssueClassificationFixture(db!);
  store.registerRuntime({ id: "rt_legacy_outbound", name: "Legacy outbound", provider: "codex", workspaceId: "local" });
  store.heartbeatRuntime("rt_legacy_outbound", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: "agt_chat_migration", runtimeId: "rt_legacy_outbound", appId: "cli_migration", domain: "feishu", enabled: true,
    appSecretOp: "set", appSecret: "fixture-only", senderAccessPolicy: "agent",
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_legacy_outbound", { appliedRevision: config.revision, state: "online" });
  const chatId = `chat_classification_${scenario}`;
  const bindingId = `fcb_${chatId}`;
  const issueId = `iss_classification_${scenario}`;
  const wakeTaskId = `tsk_${chatId}`;
  const externalChatId = `oc_${scenario}`;
  const now = "2026-09-03T00:00:00.000Z";
  if (kind === "round" || kind === "inbound") {
    db!.run(`INSERT INTO multiremi_feishu_bot_round_pushes
      (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
      VALUES ('legacy_round', 'local', ?, ?, 'tsk_chat_migration_running', ?, ?, ?, ?)`,
    [bindingId, issueId, wakeTaskId, kind === "inbound" ? "inbound" : "proactive", now, now]);
  } else if (kind === "human") {
    db!.run(`INSERT INTO multiremi_feishu_bot_human_request_pushes
      (id, workspace_id, binding_id, issue_id, source_task_id, request_id, wake_task_id, created_at, updated_at)
      VALUES ('legacy_human', 'local', ?, ?, 'tsk_chat_migration_running', 'legacy_request', ?, ?, ?)`,
    [bindingId, issueId, wakeTaskId, now, now]);
  }
  db!.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
    (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, attachments,
      status, available_at, created_at, updated_at)
    VALUES ('legacy_outbox', 'local', ?, ?, ?, ?, 'om_root', ?, ?, 'pending', ?, ?, ?)`,
  [bindingId, kind === "attachment" ? null : wakeTaskId, externalChatId,
    scenario === "group_without_thread" ? null : `om_${scenario}`,
    kind === "inbound" ? "User-requested reply" : "Old proactive Issue notification",
    kind === "attachment" ? JSON.stringify([{ id: "attachment_legacy", filename: "report.txt", contentType: "text/plain", sizeBytes: 5 }]) : null,
    now, now, now]);
  runMigrations(db!);
  const claim = () => store.claimFeishuBotOutbound("local", "rt_legacy_outbound", undefined, true, true, true);
  return { store, config, bindingId, issueId, wakeTaskId, externalChatId, claim, scenario };
}

describe("legacy Issue outbound isolation", () => {
  for (const scenario of ["unknown_legacy_group", "p2p_thread_and_key"] as const) {
    for (const kind of ["round", "human"] as const) {
      it(`holds an old ${kind} notification after migrating ${scenario}`, () => {
        const f = scaffold(scenario, kind);
        expect(db!.query("SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(f.bindingId))
          .toEqual({ issue_id: null });
        expect(f.claim()).toBeNull();
        expect(db!.query("SELECT status, attempt_count FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'legacy_outbox'").get())
          .toEqual({ status: "pending", attempt_count: 0 });
      });
    }
  }

  for (const kind of ["round", "human"] as const) {
    it(`resumes a held ${kind} notification only after the original group Issue is confirmed`, () => {
      const f = scaffold("unknown_legacy_group", kind);
      expect(f.claim()).toBeNull();
      f.store.submitFeishuBotMessage("local", "rt_legacy_outbound", {
        revision: f.config.revision, externalSessionKey: `${f.externalChatId}:thread:om_${f.scenario}`,
        externalMessageId: "confirmed_group", chatId: f.externalChatId, threadId: `om_${f.scenario}`,
        chatType: "group", senderOpenId: "ou_group_owner", text: "Continue the original group",
      });
      expect(f.claim()?.id).toBe("legacy_outbox");
    });
    it(`keeps a pending ${kind} notification blocked when the binding points to another Issue`, () => {
      const f = scaffold("unknown_legacy_group", kind);
      db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = 'iss_chat_migration' WHERE id = ?", [f.bindingId]);
      expect(f.claim()).toBeNull();
    });
    it(`continues delivering ${kind} notifications for retained group bindings`, () => {
      const f = scaffold("group_without_thread", kind);
      expect(f.claim()?.id).toBe("legacy_outbox");
    });
  }

  for (const kind of ["inbound", "attachment"] as const) {
    it(`keeps ordinary ${kind} deliveries available after private Chat decoupling`, () => {
      const f = scaffold("p2p_thread_and_key", kind);
      expect(f.claim()?.id).toBe("legacy_outbox");
    });
  }

  it("does not recreate a proactive Issue outbox when an old private task completes", () => {
    const f = scaffold("p2p_thread_and_key", "round");
    db!.run("DELETE FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'legacy_outbox'");
    // This is the completion hook called for an already-running historical task.
    f.store.completeFeishuRoundPushTaskWithinTransaction(f.store.getTask(f.wakeTaskId)!, "Stale Issue summary");
    expect(db!.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ?").all(f.wakeTaskId)).toEqual([]);
  });
});
