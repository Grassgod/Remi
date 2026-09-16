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
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CHAT_ISSUE_MIGRATION]);
}
