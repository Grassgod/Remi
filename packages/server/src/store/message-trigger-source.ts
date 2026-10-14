import type { ConversationLogEntry, MessageTriggerSource } from '@multiremi/contracts/conversation-log.js';
import type { SqlDatabase } from './db/postgres.js';

export type TriggerEntry = Pick<ConversationLogEntry, 'id' | 'kind' | 'task_id'> & { author_type?: string; sender_type?: string };
export interface MessageTriggerFact {
  entry_id: string;
  workspace_id: string;
  source_id: string;
  source_session: string;
  source_task: string | null;
  source_metadata: string | Record<string, unknown>;
  source_reply: string | null;
  source_visibility: string;
  source_deleted: string | null;
  sender_type: string;
  sender_id: string | null;
  sender_name: string | null;
  issue_id: string | null;
  issue_key: string | null;
  is_parent: number;
  parent_issue_key: string | null;
}

/** Read only the displayed outputs, using their original turn trigger, never the latest comment. */
export function messageTriggerQuery(entries: readonly TriggerEntry[]) {
  const ids = [...new Set(entries.filter(e => e.kind === 'message' && (e.sender_type ?? e.author_type) === 'agent' && e.task_id).map(e => e.id))];
  if (!ids.length) return null;
  return { params: ids, sql: `SELECT output.id AS entry_id, t.workspace_id,
    m.id AS source_id, m.session_id AS source_session, m.task_id AS source_task,
    m.metadata AS source_metadata, m.reply_to_id AS source_reply,
    m.visibility AS source_visibility, m.deleted_at AS source_deleted,
    m.sender_type, m.sender_id,
    COALESCE(agent.name, member.name, timer.title) AS sender_name,
    issue.id AS issue_id, issue.issue_key,
    parent.issue_key AS parent_issue_key,
    CASE WHEN origin.parent_issue_id=parent.id THEN 1 ELSE 0 END AS is_parent
    FROM multiremi_conversation_log output
    LEFT JOIN multiremi_turn_attempts attempt ON attempt.id=output.task_id
    JOIN multiremi_turns t ON t.id=COALESCE(attempt.turn_id,output.task_id)
    JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id
    LEFT JOIN multiremi_issue_sessions session ON session.id=m.session_id AND session.workspace_id=t.workspace_id
    LEFT JOIN multiremi_issues issue ON issue.id=session.issue_id AND issue.workspace_id=t.workspace_id
    LEFT JOIN multiremi_turn_attempts source_attempt ON source_attempt.id=m.task_id
    LEFT JOIN multiremi_turns source_turn ON source_turn.id=COALESCE(source_attempt.turn_id,m.task_id)
    LEFT JOIN multiremi_issues parent ON parent.id=COALESCE(source_turn.issue_id,issue.id) AND parent.workspace_id=t.workspace_id
    LEFT JOIN multiremi_issues origin ON origin.id=t.issue_id AND origin.workspace_id=t.workspace_id
    LEFT JOIN multiremi_agents agent ON m.sender_type='agent' AND agent.id=m.sender_id AND agent.workspace_id=t.workspace_id
    LEFT JOIN multiremi_workspace_members member ON m.sender_type='member' AND member.id=m.sender_id AND member.workspace_id=t.workspace_id
    LEFT JOIN multiremi_autopilots timer ON m.sender_type='timer' AND timer.id=m.sender_id AND timer.workspace_id=t.workspace_id
    WHERE output.id IN (${ids.map(() => '?').join(',')})` };
}

export function readMessageTriggerFacts(db: SqlDatabase, entries: readonly TriggerEntry[]): MessageTriggerFact[] {
  const query = messageTriggerQuery(entries);
  return query ? db.query(query.sql).all(...query.params) as MessageTriggerFact[] : [];
}

/** Only call after checking access to the exact source conversation and message. */
export function messageTriggerSource(fact: MessageTriggerFact): MessageTriggerSource {
  return { actor_type: fact.sender_type, actor_id: fact.sender_id, actor_name: fact.sender_name,
    message_id: fact.source_id, session_id: fact.source_session, issue_id: fact.issue_id,
    issue_key: fact.issue_key, parent_issue_key: fact.parent_issue_key, parent_issue: Number(fact.is_parent) === 1 };
}

export function triggerVisibilityEntry(fact: MessageTriggerFact) {
  let metadata: Record<string, unknown> = {};
  try { metadata = typeof fact.source_metadata === 'string' ? JSON.parse(fact.source_metadata) : fact.source_metadata; } catch {}
  return { id: fact.source_id, kind: 'message', session_id: fact.source_session,
    task_id: fact.source_task, reply_to_id: fact.source_reply, metadata };
}
