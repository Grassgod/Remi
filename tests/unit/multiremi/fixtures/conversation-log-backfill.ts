import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { bindFeishuTopicFixture } from "../feishu-topic-fixture.js";

/** Actual pre-unified inputs for the regression and reproducible migration report.
 * This writer deliberately preserves the historical absence of modern responsibility. */
export function prepareConversationBackfillFixture(store: MultiremiStore, db: SqlDatabase) {
  const agent = store.createAgent({ name: "Backfill author", provider: "codex", workspaceId: "local" });
  const issue = store.createIssue({ title: "Historical issue", description: "Historical body", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const edited = store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id, taskId: "tsk_history", body: "Original wording" });
  store.updateIssueComment(edited.id, { body: "Intermediate wording" });
  store.updateIssueComment(edited.id, { body: "Current wording" });
  store.resolveIssueComment(edited.id, { actorType: "agent", actorId: agent.id });
  store.unresolveIssueComment(edited.id);
  const deleted = store.createIssueComment(issue.id, { body: "Deleted original", taskId: "tsk_deleted" });
  store.deleteIssueComment(deleted.id);
  const system = store.createTaskFailureSystemComment(issue.id, session.id, "tsk_system", "System original");
  const linked = store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id, taskId: "tsk_linked", body: "Existing B1 mirror" });
  store.appendSessionEvent(session.id, { kind: "follow_frozen", authorType: "system", body: "Freeze notification", metadata: { follow_frozen_seq: 3 } });
  store.appendSessionEvent(session.id, { kind: "result_published", authorType: "system", body: "Published result", metadata: { z: 2, a: { z: 3, a: 1 } } });
  store.appendSessionEvent(session.id, { kind: "task_assigned", authorType: "agent", authorId: agent.id, taskId: "tsk_history", body: "Historical prompt" });
  store.appendSessionEvent(session.id, { kind: "task_steer", authorType: "member", taskId: "tsk_history", body: "Historical steer", metadata: { source_task_id: "tsk_history" } });
  const root = store.createIssueComment(issue.id, { body: "Resolved root" });
  store.resolveIssueComment(root.id);
  const child = store.createIssueComment(issue.id, { parentId: root.id, body: "Child comment" });
  store.resolveIssueComment(root.id);
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Historical chat" });
  const insertComment = (id: string, issueId: string, task: string | null) => db.run(`INSERT INTO multiremi_issue_comments
    (id, issue_id, author_type, author_id, task_id, body, type, created_at, updated_at)
    VALUES (?, ?, 'agent', ?, ?, 'Orphan original', 'comment', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`, [id, issueId, agent.id, task]);
  insertComment("cmt_orphan_valid", issue.id, "tsk_orphan");
  insertComment("cmt_orphan_missing", "iss_missing", null);
  const at = "2026-08-02T00:00:00.000Z";
  for (const [id, role, seq, task] of [["msg_history_user", "user", 1, "tsk_chat_user"], ["msg_history_assistant", "assistant", 1, "tsk_chat_reply"], ["msg_history_system", "system", 7, null]] as const) {
    db.run(`INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, sequence,
      elapsed_ms, failure_reason, pending_agent_delivery, agent_delivery_task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 12, NULL, ?, ?, ?)`, [id, chat.id, task, role, `${role} original`, seq,
      role === "system" ? 1 : 0, role === "system" ? "tsk_pending" : null, at]);
  }
  db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, chat_session_id, status, prompt, created_at, updated_at)
    VALUES ('tsk_chat_reply', 'local', ?, ?, 'completed', 'Chat reply', ?, ?)`, [agent.id, chat.id, at, at]);
  for (const [id, status] of [["tsk_cancelled_no_reply", "cancelled"], ["tsk_failed_no_reply", "failed"]]) {
    db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, chat_session_id, status, prompt, created_at, updated_at)
      VALUES (?, 'local', ?, ?, ?, 'No assistant', ?, ?)`, [id, agent.id, chat.id, status, at, at]);
  }
  const topicChat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Topic transport" });
  bindFeishuTopicFixture(store, db, topicChat.id, issue.id);
  const topic = store.sendChatMessage(topicChat.id, { content: "Historical Chat-owned topic message" });
  const preserved = store.getConversationLogEntryById(linked.id)!;
  const preservedSystem = store.getConversationLogEntryById(system.id)!;
  db.run("DELETE FROM multiremi_conversation_log WHERE session_id = ? AND id NOT IN (?, ?)", [session.id, linked.id, system.id]);
  db.run("DELETE FROM multiremi_conversation_log WHERE session_id IN (?, ?)", [chat.id, topicChat.id]);
  db.run("UPDATE multiremi_conversation_log SET task_id = NULL WHERE id IN (?, ?)", [linked.id, system.id]);
  db.run("UPDATE multiremi_conversation_heads SET head_seq = 99 WHERE session_id = ?", [session.id]);
  return { edited, deleted, system, linked, root, child, chat, session, topic, topicChat, preserved, preservedSystem };
}
