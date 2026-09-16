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
  quarantine: boolean;
  canonical?: boolean;
  synced?: Array<{ chatType: string; workspace?: string; sourceWorkspace?: string }>;
  pendingSince?: string | null;
  pendingCount?: number;
  channelEnabled?: number;
  noChannel?: boolean;
  unconsumedUpdate?: boolean;
}

export const CHAT_ISSUE_CLASSIFICATION_CASES: ClassificationCase[] = [
  { name: "p2p_thread_and_key", thread: true, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "p2p_thread_only", thread: true, key: false, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "p2p_key_only", thread: false, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "group_without_thread", thread: false, key: false, provenance: "exact", preserve: true, quarantine: false },
  { name: "wrong_binding", thread: true, key: true, provenance: "wrong_binding", preserve: false, quarantine: true },
  { name: "wrong_workspace", thread: true, key: true, provenance: "wrong_workspace", preserve: false, quarantine: true },
  { name: "wrong_source_chat", thread: true, key: true, provenance: "wrong_source_chat", preserve: false, quarantine: true },
  { name: "missing_delivery", thread: true, key: true, provenance: "missing_delivery", preserve: false, quarantine: true },
  { name: "malformed_source", thread: true, key: true, provenance: "malformed_source", preserve: false, quarantine: true },
  { name: "historical_synced_group", thread: true, key: true, provenance: "none", synced: [{ chatType: "group" }], preserve: true, quarantine: false },
  { name: "unknown_legacy_group", thread: true, key: true, provenance: "none", preserve: false, quarantine: true,
    pendingSince: "2026-09-02T12:00:00.000Z", channelEnabled: 1 },
  { name: "unknown_legacy_disabled", thread: true, key: true, provenance: "none", preserve: false, quarantine: true,
    pendingSince: "2026-09-02T12:00:00.000Z" },
  { name: "unknown_no_channel", thread: true, key: true, provenance: "none", preserve: false, quarantine: true, noChannel: true, unconsumedUpdate: false },
  { name: "unknown_future_pending", thread: true, key: true, provenance: "none", preserve: false, quarantine: true,
    pendingSince: "2999-01-01T00:00:00.000Z", unconsumedUpdate: false },
  { name: "unknown_invalid_pending", thread: true, key: true, provenance: "none", preserve: false, quarantine: true,
    pendingSince: "not-a-time", unconsumedUpdate: false },
  { name: "flushed_unconsumed_update", thread: true, key: true, provenance: "none", preserve: false, quarantine: true, pendingSince: null, pendingCount: 0 },
  { name: "sync_wrong_workspace", thread: true, key: true, provenance: "none", synced: [{ chatType: "group", workspace: "other-workspace", sourceWorkspace: "other-workspace" }], preserve: false, quarantine: true },
  { name: "sync_wrong_source_workspace", thread: true, key: true, provenance: "none", synced: [{ chatType: "group", sourceWorkspace: "other-workspace" }], preserve: false, quarantine: true },
  { name: "conflicting_chat_type", thread: true, key: true, provenance: "none", synced: [{ chatType: "group" }, { chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "canonical_p2p", canonical: true, thread: true, key: true, provenance: "none", synced: [{ chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "provenance_p2p", thread: true, key: true, provenance: "exact", synced: [{ chatType: "p2p" }], preserve: false, quarantine: false },
  { name: "invalid_sync_type", thread: true, key: true, provenance: "none", synced: [{ chatType: "unknown" }], preserve: false, quarantine: true },
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
