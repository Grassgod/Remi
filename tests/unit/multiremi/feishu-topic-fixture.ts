import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

/** Model a topic transport explicitly; Chat itself never owns the Issue. */
export function bindFeishuTopicFixture(
  store: MultiremiStore,
  db: SqlDatabase,
  chatId: string,
  issueId: string,
): void {
  const chat = store.getChatSession(chatId)!;
  const existing = db.query("SELECT id, thread_id, external_session_key FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ? LIMIT 1")
    .get(chatId);
  if (existing) {
    if (!existing.thread_id && !String(existing.external_session_key).includes(":thread:")
      && chatId !== `chat_issue_topic_${issueId}`) {
      throw new Error("Topic fixtures require a Feishu group thread, never a private conversation");
    }
    db.run("UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ? WHERE chat_session_id = ?", [issueId, chatId]);
  } else {
    const now = new Date().toISOString();
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
      (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, issue_id, chat_id, thread_id, created_at, updated_at)
      VALUES (?, ?, 'cli_topic_fixture', ?, ?, ?, ?, 'oc_topic_fixture', ?, ?, ?)`,
    [`fcb_${chatId}`, chat.workspaceId, chat.agentId, `oc_topic_fixture:thread:${chatId}`, chatId, issueId, chatId, now, now]);
  }
  store.setAgentIssueUpdateSubscription({ chatSessionId: chatId, enabled: true });
}
