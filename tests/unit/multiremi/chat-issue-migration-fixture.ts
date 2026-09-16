import { expect } from "bun:test";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";

export const CHAT_ISSUE_MIGRATION = "20260916_chat_issue_decoupling";

/** Build both supported legacy schemas after bootstrapping the other store tables. */
export function seedLegacyChatIssueFixture(db: SqlDatabase, tableForeignKey = false): void {
  runMigrations(db);
  if (tableForeignKey) {
    const schema = String(db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_chat_sessions'").get().sql);
    db.exec("DROP TABLE multiremi_chat_sessions");
    db.exec(schema.replace("agent_id TEXT NOT NULL,", "agent_id TEXT NOT NULL, issue_id TEXT,")
      .replace(/\)\s*$/, ", FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE SET NULL)"));
  } else {
    db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT REFERENCES multiremi_issues(id) ON DELETE SET NULL");
  }
  db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN fixture_extra TEXT");
  db.exec("CREATE INDEX idx_chat_fixture_extra ON multiremi_chat_sessions(fixture_extra)");
  const now = "2026-09-03T00:00:00.000Z";
  db.run("INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at) VALUES ('agt_chat_migration', 'Migration', 'codex', ?, ?)", [now, now]);
  db.run("INSERT INTO multiremi_issues (id, title, status, created_at, updated_at) VALUES ('iss_chat_migration', 'Migration', 'todo', ?, ?)", [now, now]);
  db.run("UPDATE multiremi_issues SET context_refs = ? WHERE id = 'iss_chat_migration'", [JSON.stringify([{
    type: "feishu_bot_message", message_id: "om_group_migration", chat_id: "oc_group", thread_id: "om_root",
  }])]);
  for (const id of ["chat_issue_topic_iss_chat_migration", "chat_group_migration", "chat_private_migration", "chat_web_migration"]) {
    db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, issue_id, title, created_at, updated_at,
      session_id, work_dir, session_runtime_id, session_provider, session_execution_fingerprint, fixture_extra)
      VALUES (?, 'agt_chat_migration', 'iss_chat_migration', 'Legacy', ?, ?, 'provider-legacy', '/work/keep', 'rt_legacy', 'codex', 'legacy-fingerprint', 'preserve extra')`, [id, now, now]);
    for (const role of ["user", "assistant", "system"]) {
      db.run(`INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, pending_agent_delivery, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [`${id}_${role}`, id, role, role === "system" ? "Bound Issue update: Legacy" : `${role} text`, role === "system" ? 1 : 0, now]);
    }
    db.run(`INSERT INTO multiremi_notification_channels (id, workspace_id, kind, name, enabled, target, event_types, min_severity, created_at, updated_at)
      VALUES (?, 'local', 'agent_chat', 'Legacy updates', 0, ?, '["*"]', 'info', ?, ?)`, [`nch_agent_chat_${id}`, JSON.stringify({ chatId: id }), now, now]);
    db.run(`INSERT INTO multiremi_agent_issue_update_state (chat_session_id, workspace_id, issue_id, channel_id, pending_count, created_at, updated_at)
      VALUES (?, 'local', 'iss_chat_migration', ?, 1, ?, ?)`, [id, `nch_agent_chat_${id}`, now, now]);
  }
  for (const [chatId, key] of [
    ["chat_issue_topic_iss_chat_migration", "pending:iss_chat_migration"],
    ["chat_group_migration", "oc_group:thread:om_root"],
    ["chat_private_migration", "oc_private"],
  ]) {
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
      VALUES (?, 'local', 'cli_migration', 'agt_chat_migration', ?, ?, ?, ?)`, [`fcb_${chatId}`, key, chatId, now, now]);
  }
  db.run("UPDATE multiremi_feishu_bot_chat_bindings SET chat_id = 'oc_group' WHERE chat_session_id = 'chat_group_migration'");
  db.run(`INSERT INTO multiremi_issue_sessions (id, issue_id, workspace_id, title, created_at, updated_at)
    VALUES ('ises_legacy_chat_migration', 'iss_chat_migration', 'local', 'Legacy Main', ?, ?)`, [now, now]);
  for (const status of ["queued", "dispatched", "running"]) {
    db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, chat_session_id, prompt, status, session_id, work_dir, issue_session_id, issue_session_generation, created_at, updated_at)
      VALUES (?, 'local', 'agt_chat_migration', 'iss_chat_migration', 'chat_web_migration', 'Legacy task', ?, 'provider-legacy-task', '/work/keep', 'ises_legacy_chat_migration', 2, ?, ?)`,
    [`tsk_chat_migration_${status}`, status, now, now]);
  }
  db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, chat_session_id, prompt,
    status, issue_session_id, issue_session_generation, created_at, updated_at)
    VALUES ('tsk_topic_migration_queued', 'local', 'agt_chat_migration', 'iss_chat_migration', 'chat_group_migration',
      'Legacy topic task', 'queued', 'ises_legacy_chat_migration', 2, ?, ?)`, [now, now]);
  db.run(`INSERT INTO multiremi_feishu_bot_deliveries
    (workspace_id, external_message_id, binding_id, task_id, created_at, updated_at)
    VALUES ('local', 'om_group_migration', 'fcb_chat_group_migration', 'tsk_topic_migration_queued', ?, ?)`, [now, now]);
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CHAT_ISSUE_MIGRATION]);
}

interface ClassificationCase {
  name: string;
  thread: boolean;
  key: boolean;
  provenance: "none" | "exact" | "wrong_binding" | "wrong_workspace" | "wrong_source_chat" | "missing_delivery" | "malformed_source";
  preserve: boolean;
  canonical?: boolean;
  synced?: Array<{ chatType: string; workspace?: string; sourceWorkspace?: string }>;
  pendingSince?: string | null;
  pendingCount?: number;
  channelEnabled?: number;
  noChannel?: boolean;
  unconsumedUpdate?: boolean;
}

export const CHAT_ISSUE_CLASSIFICATION_CASES: ClassificationCase[] = [
  { name: "p2p_thread_and_key", thread: true, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false },
  { name: "p2p_thread_only", thread: true, key: false, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false },
  { name: "p2p_key_only", thread: false, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false },
  { name: "group_without_thread", thread: false, key: false, provenance: "exact", preserve: true },
  { name: "wrong_binding", thread: true, key: true, provenance: "wrong_binding", preserve: false },
  { name: "wrong_workspace", thread: true, key: true, provenance: "wrong_workspace", preserve: false },
  { name: "wrong_source_chat", thread: true, key: true, provenance: "wrong_source_chat", preserve: false },
  { name: "missing_delivery", thread: true, key: true, provenance: "missing_delivery", preserve: false },
  { name: "malformed_source", thread: true, key: true, provenance: "malformed_source", preserve: false },
  { name: "historical_synced_group", thread: true, key: true, provenance: "none", synced: [{ chatType: "group" }], preserve: true },
  { name: "unknown_legacy_group", thread: true, key: true, provenance: "none", preserve: false,
    pendingSince: "2026-09-02T12:00:00.000Z", channelEnabled: 1 },
  { name: "unknown_legacy_disabled", thread: true, key: true, provenance: "none", preserve: false,
    pendingSince: "2026-09-02T12:00:00.000Z" },
  { name: "unknown_no_channel", thread: true, key: true, provenance: "none", preserve: false, noChannel: true, unconsumedUpdate: false },
  { name: "sync_wrong_workspace", thread: true, key: true, provenance: "none", synced: [{ chatType: "group", workspace: "other-workspace", sourceWorkspace: "other-workspace" }], preserve: false },
  { name: "sync_wrong_source_workspace", thread: true, key: true, provenance: "none", synced: [{ chatType: "group", sourceWorkspace: "other-workspace" }], preserve: false },
  { name: "conflicting_chat_type", thread: true, key: true, provenance: "none", synced: [{ chatType: "group" }, { chatType: "p2p" }], preserve: false },
  { name: "canonical_p2p", canonical: true, thread: true, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false },
  { name: "provenance_p2p", thread: true, key: true, provenance: "exact", synced: [{ chatType: "p2p" }], preserve: false },
  { name: "invalid_sync_type", thread: true, key: true, provenance: "none", synced: [{ chatType: "unknown" }], preserve: false },
];

export function classificationChatId(entry: ClassificationCase): string {
  return entry.canonical ? `chat_issue_topic_iss_classification_${entry.name}` : `chat_classification_${entry.name}`;
}

/** Legacy bindings did not persist chat_type, even for explicit p2p threads. */
export function seedLegacyChatIssueClassificationFixture(db: SqlDatabase, tableForeignKey = false): void {
  seedLegacyChatIssueFixture(db, tableForeignKey);
  const now = "2026-09-03T00:00:00.000Z";
  for (const entry of CHAT_ISSUE_CLASSIFICATION_CASES) {
    const chatId = classificationChatId(entry);
    const issueId = `iss_classification_${entry.name}`;
    const bindingId = `fcb_${chatId}`;
    const messageId = `om_${entry.name}`;
    const externalChatId = `oc_${entry.name}`;
    const contextRefs = entry.provenance === "malformed_source" ? "{invalid"
      : JSON.stringify(entry.provenance === "none" ? [] : [{
        type: "feishu_bot_message", message_id: messageId,
        chat_id: entry.provenance === "wrong_source_chat" ? "oc_another_chat" : externalChatId,
        thread_id: messageId,
      }]);
    db.run(`INSERT INTO multiremi_issues (id, title, status, context_refs, created_at, updated_at)
      VALUES (?, ?, 'todo', ?, ?, ?)`, [issueId, entry.name, contextRefs, now, now]);
    db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, issue_id, title, created_at, updated_at,
      session_id, work_dir, session_runtime_id, session_provider, session_execution_fingerprint)
      VALUES (?, 'agt_chat_migration', ?, ?, ?, ?, 'provider-legacy', '/work/keep', 'rt_legacy', 'codex', 'legacy-fingerprint')`,
    [chatId, issueId, entry.name, now, now]);
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, thread_id, created_at, updated_at)
      VALUES (?, 'local', 'cli_migration', 'agt_chat_migration', ?, ?, ?, ?, ?, ?)`,
    [bindingId, entry.key ? `${externalChatId}:thread:${messageId}` : externalChatId,
      chatId, externalChatId, entry.thread ? messageId : null, now, now]);
    db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, chat_session_id, prompt,
      status, session_id, work_dir, created_at, updated_at)
      VALUES (?, 'local', 'agt_chat_migration', ?, ?, 'Legacy', 'queued', 'provider-task-legacy', '/work/keep', ?, ?)`,
    [`tsk_${chatId}`, issueId, chatId, now, now]);
    if (entry.provenance !== "none" && entry.provenance !== "missing_delivery") {
      db.run(`INSERT INTO multiremi_feishu_bot_deliveries
        (workspace_id, external_message_id, binding_id, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [entry.provenance === "wrong_workspace" ? "other-workspace" : "local",
        messageId, entry.provenance === "wrong_binding" ? "fcb_chat_private_migration" : bindingId,
        `tsk_${chatId}`, now, now]);
    }
    for (const role of ["user", "assistant", "system"]) {
      db.run(`INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, pending_agent_delivery, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [`${chatId}_${role}`, chatId, role,
        role === "system" ? "Bound Issue update: Legacy" : `${role} text`, role === "system" && entry.unconsumedUpdate !== false ? 1 : 0, now]);
    }
    if (!entry.noChannel) {
      db.run(`INSERT INTO multiremi_notification_channels
        (id, workspace_id, kind, name, enabled, target, event_types, min_severity, created_by, created_at, updated_at)
        VALUES (?, 'local', 'agent_chat', 'Legacy updates', ?, ?, '["comment_created"]', 'warning', 'legacy-owner', ?, ?)`,
      [`nch_agent_chat_${chatId}`, entry.channelEnabled ?? 0, JSON.stringify({ chatId }), now, now]);
      db.run(`INSERT INTO multiremi_agent_issue_update_state
        (chat_session_id, workspace_id, issue_id, channel_id, pending_count, pending_since, created_at, updated_at)
        VALUES (?, 'local', ?, ?, ?, ?, ?, ?)`, [chatId, issueId, `nch_agent_chat_${chatId}`, entry.pendingCount ?? 1, entry.pendingSince ?? null, now, now]);
    }
    for (const [index, evidence] of (entry.synced ?? []).entries()) {
      const sourceId = `fsrc_${entry.name}_${index}`;
      db.run(`INSERT INTO multiremi_feishu_sources (id, workspace_id, endpoint_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`, [sourceId, evidence.sourceWorkspace ?? "local", sourceId, now, now]);
      db.run(`INSERT INTO multiremi_feishu_messages (message_id, workspace_id, source_id, chat_id, chat_type,
        content_fingerprint, created_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`sync_${entry.name}_${index}`, evidence.workspace ?? "local", sourceId, externalChatId,
        evidence.chatType, `fingerprint_${entry.name}_${index}`, now, now]);
    }
  }
}

const WAKE_FIXTURE_NAMES = ["group_without_thread", "unknown_legacy_group", "p2p_thread_and_key", "explicitly_unbound"];

/** Old proactive work must terminate at migration, while real user work survives. */
export function seedLegacyChatWakeFixture(db: SqlDatabase): void {
  const now = "2026-09-03T00:00:00.000Z";
  db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, issue_id, title, session_id, created_at, updated_at)
    VALUES ('chat_classification_explicitly_unbound', 'agt_chat_migration', NULL,
      'Explicitly unbound before upgrade', 'old-unbound-provider', ?, ?)`, [now, now]);
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
    (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, created_at, updated_at)
    VALUES ('fcb_chat_classification_explicitly_unbound', 'local', 'cli_migration', 'agt_chat_migration',
      'oc_explicitly_unbound', 'chat_classification_explicitly_unbound', 'oc_explicitly_unbound', ?, ?)`, [now, now]);
  for (const name of WAKE_FIXTURE_NAMES) {
    const chatId = `chat_classification_${name}`;
    const bindingId = `fcb_${chatId}`;
    const issueId = name === "explicitly_unbound" ? "iss_chat_migration" : `iss_classification_${name}`;
    for (const source of ["round", "human", "inbound"]) {
      for (const status of ["queued", "dispatched", "running", "completed"]) {
        const id = `wake_${name}_${source}_${status}`;
        // Legacy explicit rebind changed Chat ownership without cancelling old
        // work. Dispatched pushes still target A while the Chat now owns B.
        const sourceIssueId = status === "dispatched" ? "iss_chat_migration" : issueId;
        db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, chat_session_id,
          prompt, status, session_id, created_at, updated_at)
          VALUES (?, 'local', 'agt_chat_migration', ?, ?, ?, ?, 'old-wake-provider', ?, ?)`,
        [id, sourceIssueId, chatId, source === "inbound" ? "Real user question" : "PRIVATE_ISSUE_WAKE_SENTINEL", status, now, now]);
        if (name === "explicitly_unbound" && source === "inbound" && ["queued", "dispatched"].includes(status)) {
          // A user turn queued after explicit unbind already has null ownership
          // but still inherited the provider pointer from the contaminated Chat.
          db.run("UPDATE multiremi_tasks SET issue_id = NULL WHERE id = ?", [id]);
        }
        if (source === "human") {
          db.run(`INSERT INTO multiremi_feishu_bot_human_request_pushes
            (id, workspace_id, binding_id, issue_id, source_task_id, request_id, wake_task_id, created_at, updated_at)
            VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`, [id, bindingId, sourceIssueId, `tsk_${chatId}`, id, id, now, now]);
        } else {
          db.run(`INSERT INTO multiremi_feishu_bot_round_pushes
            (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
            VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
          [id, bindingId, sourceIssueId, id, id, source === "round" ? "proactive" : "inbound", now, now]);
        }
        const outboxStatus = status === "completed" ? "sent" : status === "dispatched" ? "sending" : "pending";
        db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
          (id, workspace_id, binding_id, task_id, chat_id, body, status, available_at, created_at, updated_at)
          VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`out_${id}`, bindingId, id, `oc_${name}`, source === "inbound" ? "Real reply" : "PRIVATE_ISSUE_WAKE_SENTINEL", outboxStatus, now, now, now]);
        for (const author of ["system", "user"]) {
          db.run(`INSERT INTO multiremi_task_steer_messages
            (id, task_id, author_type, kind, content, created_at) VALUES (?, ?, ?, 'steer', ?, ?)`,
          [`steer_${id}_${author}`, id, author,
            author === "system" ? "The responsible agent completed a work round for PRIVATE_ISSUE_WAKE_SENTINEL." : "User clarification", now]);
        }
      }
    }
    // File delivery has no task id and must not be removed with the old wake.
    db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
      (id, workspace_id, binding_id, chat_id, body, attachments, previous_delivery_id,
       status, available_at, created_at, updated_at)
      VALUES (?, 'local', ?, ?, '', ?, ?, 'pending', ?, ?, ?)`,
    [`attachment_${name}`, bindingId, `oc_${name}`,
      JSON.stringify([{ id: "file_fixture", filename: "normal.txt", contentType: "text/plain", sizeBytes: 1 }]),
      `out_wake_${name}_human_queued`, now, now, now]);
  }
}

export function assertLegacyChatWakeSettlement(db: SqlDatabase): void {
  for (const name of WAKE_FIXTURE_NAMES) {
    const preserved = name === "group_without_thread";
    // This retained topic has an old A→B dispatched wake, so its provider is dirty.
    expect(db.query("SELECT session_id FROM multiremi_chat_sessions WHERE id = ?").get(`chat_classification_${name}`))
      .toEqual({ session_id: null });
    for (const source of ["round", "human", "inbound"]) {
      for (const status of ["queued", "dispatched", "running", "completed"]) {
        const id = `wake_${name}_${source}_${status}`;
        const destinationMatches = preserved && status !== "dispatched";
        const cancelled = !destinationMatches && source !== "inbound" && ["queued", "dispatched"].includes(status);
        const task = db.query("SELECT status, cancelled_at, completed_at, prompt FROM multiremi_tasks WHERE id = ?").get(id);
        expect(task.status).toBe(cancelled ? "cancelled" : status);
        expect(task.prompt).toBe(source === "inbound" ? "Real user question" : "PRIVATE_ISSUE_WAKE_SENTINEL");
        if (["queued", "dispatched"].includes(status)) {
          expect(db.query("SELECT issue_id, session_id FROM multiremi_tasks WHERE id = ?").get(id))
            .toEqual({ issue_id: cancelled || !preserved ? null : status === "dispatched" ? "iss_chat_migration" : `iss_classification_${name}`, session_id: null });
        }
        if (cancelled) {
          expect(Number.isFinite(Date.parse(task.cancelled_at))).toBe(true);
          expect(task.completed_at).toBe(task.cancelled_at);
        }
        const outbound = db.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(`out_${id}`);
        expect(Boolean(outbound)).toBe(destinationMatches || source === "inbound" || status === "completed");
        expect(Boolean(db.query("SELECT id FROM multiremi_task_steer_messages WHERE id = ?").get(`steer_${id}_system`)))
          .toBe(destinationMatches || source === "human");
        expect(db.query("SELECT content FROM multiremi_task_steer_messages WHERE id = ?").get(`steer_${id}_user`))
          .toEqual({ content: "User clarification" });
      }
    }
    const attachment = db.query("SELECT attachments, previous_delivery_id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(`attachment_${name}`);
    expect(JSON.parse(attachment.attachments)[0].filename).toBe("normal.txt");
    expect(attachment.previous_delivery_id).toBe(preserved ? `out_wake_${name}_human_queued` : null);
  }
}

/** Exercise worker and callback entry points after the real migration. */
export function assertCancelledLegacyWakesCannotRun(db: SqlDatabase, store = new MultiremiStore(db)): void {
  const chatId = "chat_classification_p2p_thread_and_key";
  const before = store.listChatMessages(chatId);
  for (const name of ["p2p_thread_and_key", "group_without_thread"]) {
  for (const source of ["round", "human"]) {
    for (const status of ["queued", "dispatched"]) {
      if (name === "group_without_thread" && status !== "dispatched") continue;
      const id = `wake_${name}_${source}_${status}`;
      // Simulate a daemon that already consumed steering: cancellation itself
      // must reject completion, independently of the pending-steer guard.
      db.run("UPDATE multiremi_task_steer_messages SET consumed_at = ? WHERE task_id = ?", [new Date().toISOString(), id]);
      expect(() => store.completeTask(id, { output: "PRIVATE_ISSUE_WAKE_SENTINEL", sessionId: "tainted-provider" }))
        .toThrow("Task not found or terminal");
      expect(() => store.failTask(id, { error: "late wake callback", sessionId: "tainted-provider" }))
        .toThrow("Task not found or terminal");
      expect(store.getTask(id)?.status).toBe("cancelled");
    }
  }
  }
  expect(store.listChatMessages(chatId)).toEqual(before);
  expect(store.getChatSession(chatId)?.sessionId).toBeNull();
  // Finish the unrelated fixtures so the worker is free to claim the new user
  // turn; old cancelled wake tasks still exist with higher priority.
  db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE status <> 'cancelled'");
  db.run("UPDATE multiremi_tasks SET priority = 9999 WHERE status = 'cancelled'");
  const runtime = store.registerRuntime({ name: "Migration callback check", provider: "codex", workspaceId: "local" });
  const next = store.createTask({ agentId: "agt_chat_migration", workspaceId: "local", chatSessionId: chatId,
    prompt: "A new private question", runtimeId: runtime.id });
  expect(JSON.stringify(store.buildTaskSessionProjection(next.id))).not.toContain("PRIVATE_ISSUE_WAKE_SENTINEL");
  expect(store.claimTask(runtime.id)?.id).toBe(next.id);
}

export function assertLegacyChatWakeRollback(db: SqlDatabase): void {
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "run") return (sql: string, params?: unknown[]) => {
        const result = params === undefined ? target.run(sql) : target.run(sql, params);
        if (sql.startsWith("DELETE FROM multiremi_feishu_bot_outbound_deliveries")
          && sql.includes("status <> 'sent'")) throw new Error("injected after proactive cleanup");
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(() => runMigrations(wrapped)).toThrow("injected after proactive cleanup");
  expect(db.query("SELECT status FROM multiremi_tasks WHERE id = 'wake_p2p_thread_and_key_human_queued'").get())
    .toEqual({ status: "queued" });
  expect(db.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'out_wake_p2p_thread_and_key_human_queued'").get())
    .toEqual({ status: "pending" });
  expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_issue_link_audit").get().count)).toBe(0);
  expect((db.query("PRAGMA table_info(multiremi_chat_sessions)").all() as Array<{ name: string }>).map((column) => column.name))
    .toContain("issue_id");
  expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?").get(CHAT_ISSUE_MIGRATION).count)).toBe(0);
}

interface MigrationTokenFixture { token: string; taskId: string; id: string }

export async function mintLegacyWakeTokens(db: SqlDatabase): Promise<MigrationTokenFixture[]> {
  const tokens = new AccessTokensRepo(db);
  const result: MigrationTokenFixture[] = [];
  const tasks = db.query(`SELECT id, agent_id, workspace_id FROM multiremi_tasks
    WHERE id LIKE 'wake_%' AND status IN ('queued', 'dispatched')`).all() as Array<{
      id: string; agent_id: string; workspace_id: string;
    }>;
  for (const task of tasks) {
    const token = await tokens.createTaskAccessToken({ id: task.id, agentId: task.agent_id, workspaceId: task.workspace_id }, "local");
    expect(await tokens.verifyAccessToken(token.token)).not.toBeNull();
    result.push({ token: token.token, taskId: task.id, id: token.id });
  }
  return result;
}

export async function assertLegacyWakeTokens(db: SqlDatabase, tokens: MigrationTokenFixture[], rolledBack = false): Promise<void> {
  const repo = new AccessTokensRepo(db);
  for (const token of tokens) {
    const cancelled = db.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(token.taskId).status === "cancelled";
    if (cancelled && !rolledBack) {
      expect(await repo.verifyAccessToken(token.token)).toBeNull();
      expect(Number.isFinite(Date.parse(repo.getAccessToken(token.id)!.revokedAt!))).toBe(true);
    } else {
      expect(await repo.verifyAccessToken(token.token)).not.toBeNull();
      expect(repo.getAccessToken(token.id)!.revokedAt).toBeNull();
    }
  }
}

interface WakeInvariantCase { name: string; binding: string | null | undefined; push: string | null; task: string | null; identity?: string }

// Every equality class of binding × push × task ownership. NULL push means no
// push row: push.issue_id is NOT NULL in both production schemas.
export const WAKE_INVARIANT_CASES: WakeInvariantCase[] = [
  ...[undefined, null, "A", "B"].flatMap((binding) => [null, "A", "B"].flatMap((push) => [null, "A", "B"].map((task) => ({
    name: `${binding === undefined ? "missing" : binding ?? "null"}_${push ?? "no_push"}_${task ?? "null"}`, binding, push, task,
  })))),
  ...["workspace", "agent", "chat", "issue_workspace"].map((identity) => ({
    name: `identity_${identity}`, binding: "A", push: "A", task: "A", identity,
  })),
];

export function seedWakeInvariantMatrix(db: SqlDatabase): void {
  const now = "2026-09-03T00:00:00.000Z";
  for (const issue of ["A", "B"]) db.run(`INSERT INTO multiremi_issues
    (id, issue_key, title, status, created_at, updated_at) VALUES (?, ?, 'Invariant fixture', 'todo', ?, ?)`, [`iss_matrix_${issue}`, `MATRIX-${issue}`, now, now]);
  const issue = (value: string | null | undefined) => value ? `iss_matrix_${value}` : null;
  for (const entry of WAKE_INVARIANT_CASES) {
    const chat = `chat_matrix_${entry.name}`;
    const binding = `fcb_${chat}`;
    db.run(`INSERT INTO multiremi_chat_sessions
      (id, agent_id, issue_id, title, session_id, session_provider, session_execution_fingerprint,
       session_runtime_id, created_at, updated_at)
      VALUES (?, 'agt_chat_migration', ?, 'Matrix', 'old-provider', 'codex', 'old-fingerprint', 'old-runtime', ?, ?)`,
    [chat, issue(entry.binding), now, now]);
    if (entry.binding !== undefined) {
      db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
        (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, chat_id, issue_id, created_at, updated_at)
        VALUES (?, ?, 'cli_matrix', ?, ?, ?, ?, ?, ?, ?)`,
      [binding, entry.identity === "workspace" ? "wrong_workspace" : "local",
        entry.identity === "agent" ? "wrong_agent" : "agt_chat_migration", chat,
        entry.identity === "chat" ? "chat_matrix_missing_destination" : chat, `oc_${chat}`, issue(entry.binding), now, now]);
      if (entry.identity === "issue_workspace") {
        db.run(`INSERT INTO multiremi_issues (id, workspace_id, title, status, created_at, updated_at)
          VALUES ('iss_matrix_cross_workspace', 'wrong_workspace', 'Wrong workspace', 'todo', ?, ?)`, [now, now]);
        db.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = 'iss_matrix_cross_workspace' WHERE id = ?", [binding]);
      }
    }
    for (const status of ["queued", "dispatched"]) {
      const task = `wake_matrix_${entry.name}_${status}`;
      db.run(`INSERT INTO multiremi_tasks
        (id, workspace_id, agent_id, issue_id, chat_session_id, prompt, status, session_id, created_at, updated_at)
        VALUES (?, 'local', 'agt_chat_migration', ?, ?, ?, ?, 'old-task-provider', ?, ?)`,
      [task, issue(entry.task), chat, entry.push ? "PRIVATE_MATRIX_WAKE" : "Ordinary user question", status, now, now]);
      if (entry.push) {
        db.run(`INSERT INTO multiremi_feishu_bot_round_pushes
          (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
          VALUES (?, 'local', ?, ?, ?, ?, 'proactive', ?, ?)`, [task, binding, issue(entry.push), task, task, now, now]);
        db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
          (id, workspace_id, binding_id, task_id, chat_id, body, status, available_at, created_at, updated_at)
          VALUES (?, 'local', ?, ?, ?, 'PRIVATE_MATRIX_WAKE', 'pending', ?, ?, ?)`, [`out_${task}`, binding, task, chat, now, now, now]);
        db.run(`INSERT INTO multiremi_task_steer_messages (id, task_id, author_type, kind, content, created_at)
          VALUES (?, ?, 'system', 'steer', 'The responsible agent completed a work round for PRIVATE_MATRIX_WAKE.', ?)`, [`steer_${task}`, task, now]);
      }
    }
  }
  // An inbound user task can carry a current A notification and stale B
  // notification simultaneously. Only B is settled; user work and A survive.
  for (const status of ["queued", "dispatched"]) {
    const task = `wake_matrix_A_no_push_A_${status}`;
    for (const issue of ["A", "B"]) {
      const push = `mixed_round_${issue}_${status}`;
      db.run(`INSERT INTO multiremi_feishu_bot_round_pushes
        (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
        VALUES (?, 'local', 'fcb_chat_matrix_A_no_push_A', ?, ?, ?, 'inbound', ?, ?)`,
      [push, `iss_matrix_${issue}`, push, task, now, now]);
      db.run(`INSERT INTO multiremi_task_steer_messages (id, task_id, author_type, kind, content, created_at)
        VALUES (?, ?, 'system', 'steer', ?, ?)`, [push, task,
        `The responsible agent completed a work round for MATRIX-${issue} - notification.`, now]);
    }
  }
  // Partial/no-pointer ordinary Chats must cold-start too; directory ownership
  // survives independently of whether a session was previously resumable.
  for (const pointers of ["none", "session", "provider", "fingerprint", "runtime", "all"]) {
    const chat = `chat_matrix_pointers_${pointers}`;
    db.run(`INSERT INTO multiremi_chat_sessions
      (id, agent_id, title, session_id, session_provider, session_execution_fingerprint, session_runtime_id, work_dir, created_at, updated_at)
      VALUES (?, 'agt_chat_migration', 'Pointers', ?, ?, ?, ?, ?, ?, ?)`, [chat,
      ["session", "all"].includes(pointers) ? "old-provider" : null,
      ["provider", "all"].includes(pointers) ? "codex" : null,
      ["fingerprint", "all"].includes(pointers) ? "old-fingerprint" : null,
      ["runtime", "all"].includes(pointers) ? "old-runtime" : null,
      pointers === "all" ? "/work/keep" : null, now, now]);
  }
}

export function assertWakeInvariantMatrix(db: SqlDatabase): void {
  for (const entry of WAKE_INVARIANT_CASES) {
    const matched = Boolean(entry.binding && entry.binding === entry.push && entry.binding === entry.task && !entry.identity);
    const ordinary = !entry.binding || Boolean(entry.identity);
    const dirty = ordinary || entry.name === "A_no_push_A" || Boolean(entry.push && !matched) || Boolean(entry.task && entry.task !== entry.binding);
    for (const status of ["queued", "dispatched"]) {
      const id = `wake_matrix_${entry.name}_${status}`;
      expect(db.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(id).status)
        .toBe(entry.push && !matched ? "cancelled" : status);
      if (entry.push) {
        expect(Boolean(db.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(`out_${id}`))).toBe(matched);
        expect(Boolean(db.query("SELECT id FROM multiremi_task_steer_messages WHERE id = ?").get(`steer_${id}`))).toBe(matched);
      }
    }
    expect(db.query("SELECT session_id FROM multiremi_chat_sessions WHERE id = ?").get(`chat_matrix_${entry.name}`).session_id)
      .toBe(dirty ? null : "old-provider");
  }
  for (const pointers of ["none", "session", "provider", "fingerprint", "runtime", "all"]) {
    expect(db.query(`SELECT session_id, session_provider, session_execution_fingerprint, session_runtime_id, work_dir
      FROM multiremi_chat_sessions WHERE id = ?`).get(`chat_matrix_pointers_${pointers}`)).toEqual({
      session_id: null, session_provider: null, session_execution_fingerprint: null,
      session_runtime_id: pointers === "all" ? "old-runtime" : null, work_dir: pointers === "all" ? "/work/keep" : null,
    });
  }
  for (const status of ["queued", "dispatched"]) {
    expect(db.query("SELECT content FROM multiremi_task_steer_messages WHERE id = ?").get(`mixed_round_A_${status}`))
      .toEqual({ content: "The responsible agent completed a work round for MATRIX-A - notification." });
    expect(db.query("SELECT id FROM multiremi_task_steer_messages WHERE id = ?").get(`mixed_round_B_${status}`)).toBeNull();
  }
  const store = new MultiremiStore(db);
  const next = store.createTask({ agentId: "agt_chat_migration", workspaceId: "local",
    chatSessionId: "chat_matrix_null_no_push_null", prompt: "Cold start after explicit unbind without pushes" });
  expect(next.sessionId).toBeNull();
  expect(next.runtimeId).not.toBe("old-runtime");
}
