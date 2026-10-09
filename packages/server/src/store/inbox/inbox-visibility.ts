import type { SqlDatabase } from '../db/postgres.js';
import { questionNotificationVisibilitySql } from './question-notification-visibility.js';

export interface InboxAccess { userId: string | null; admin: boolean; attemptId?: string }

/** The same source boundaries as conversationEntryVisibility, applied before
 * counts and pagination so hidden bodies never cross the synchronous bridge. */
export function inboxVisibilitySql(db: SqlDatabase, access: InboxAccess,
  source: { from: string; params: unknown[] }) {
  const params: unknown[] = [];
  const json = (alias: string, path: string) => db.dialect === 'postgres'
    ? `${alias}.metadata::jsonb #>> '{${path.replaceAll('.', ',')}}'`
    : `json_extract(${alias}.metadata,'$.${path}')`;
  const sourceNotification = (alias: string) => `CAST(${json(alias, 'question_source_notification')} AS TEXT) IN ('true','1')`;
  const inherits = (alias: string) => `(${json(alias, 'human_response')} IS NOT NULL OR ${json(alias, 'target_seq')} IS NOT NULL OR ${json(alias, 'message_id')} IS NOT NULL OR ${sourceNotification(alias)})`;
  const related = (alias: string, next: string) => `((${next}.session_id=${alias}.session_id AND (
    ${next}.id=COALESCE(${alias}.reply_to_id,${json(alias, 'message_id')}) OR
    CAST(${next}.seq AS TEXT)=CAST(${json(alias, 'target_seq')} AS TEXT))) OR
    ${sourceNotification(alias)} AND ${next}.id=${json(alias, 'root_question_id')})`;
  const chatGuard = (chat: string, turn: string) => {
    if (access.attemptId) { params.push(access.attemptId); return `${turn}.current_attempt_id=?`; }
    if (access.userId) { params.push(access.userId); return `${chat}.creator_id=?`; }
    return '1=1';
  };
  const conversation = `(s.id IS NOT NULL OR a.id IS NOT NULL OR m.session_id='auto_orphan_inbox_'||h.workspace_id
    OR c.id IS NOT NULL AND ${access.attemptId
      ? (params.push(access.attemptId), "EXISTS (SELECT 1 FROM multiremi_turns own WHERE own.session_id=c.id AND own.current_attempt_id=?)")
      : access.userId ? (params.push(access.userId), 'c.creator_id=?') : '1=1'})`;
  const sourceChatGuard = chatGuard('sc', 't');
  const sourceAgentGuard = access.userId && !access.admin
    ? (params.push(access.userId), "(ag.visibility<>'private' OR ag.owner_id=?)") : '1=1';
  const conversationAgentGuard = access.userId && !access.admin && !access.attemptId
    ? (params.push(access.userId), "(c.id IS NULL OR EXISTS (SELECT 1 FROM multiremi_agents ca WHERE ca.id=c.agent_id AND (ca.visibility<>'private' OR ca.owner_id=?)))") : '1=1';
  const protectedSource = `(d.kind='turn' OR ${json('d', 'human_request')} IS NOT NULL
    OR ${json('d', 'human_response')} IS NOT NULL AND d.task_id IS NOT NULL)`;
  const sourceIssue = `COALESCE(${json('d', 'decision_record.source_issue_id')},${json('d', 'source_issue_id')})`;
  // Plain replies inherit only a native notification grant. The source flag
  // keeps existing Task/private-trace checks on their original typed paths.
  // Seed only the same unread candidates as the page/count query; source joins
  // below still follow their references outside that candidate set.
  const cte = `WITH RECURSIVE ancestors AS (
    SELECT m.id AS root_id,m.id,m.session_id,m.task_id,m.kind,m.reply_to_id,m.to_agent_id,m.metadata,0 AS depth,1 AS source_inherited
    ${source.from}
    UNION ALL
    SELECT d.root_id,n.id,n.session_id,n.task_id,n.kind,n.reply_to_id,n.to_agent_id,n.metadata,d.depth+1,
      CASE WHEN d.source_inherited=1 AND ${inherits('d')} THEN 1 ELSE 0 END
    FROM ancestors d JOIN multiremi_conversation_log n ON ${related('d', 'n')}
    WHERE d.depth<4 AND (${inherits('d')} OR d.reply_to_id IS NOT NULL)
  )`;
  const where = `${conversation} AND NOT EXISTS (
    SELECT 1 FROM ancestors d
    LEFT JOIN multiremi_turns t ON t.id=d.task_id OR t.current_attempt_id=d.task_id
    LEFT JOIN multiremi_agents ag ON ag.id=t.agent_id
    LEFT JOIN multiremi_chat_sessions sc ON sc.id=t.session_id
    LEFT JOIN multiremi_issue_sessions ds ON ds.id=d.session_id
    LEFT JOIN multiremi_issues di ON di.id=ds.issue_id
    LEFT JOIN multiremi_issues si ON si.id=${sourceIssue}
    WHERE d.root_id=m.id AND d.source_inherited=1 AND (
      ${protectedSource} AND (t.id IS NULL OR t.workspace_id<>h.workspace_id
        OR t.session_id LIKE 'chat_%' AND (sc.id IS NULL OR NOT (${sourceChatGuard}))
        OR t.session_id NOT LIKE 'chat_%' AND NOT (${sourceAgentGuard}))
      OR ${json('d', 'human_response')} IS NOT NULL AND d.task_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM multiremi_conversation_log n WHERE ${related('d', 'n')})
      OR ${sourceNotification('d')} AND NOT EXISTS (
        SELECT 1 FROM multiremi_conversation_log n WHERE n.id=${json('d', 'root_question_id')})
      OR ${sourceIssue} IS NOT NULL AND (di.id IS NULL OR si.id IS NULL OR di.workspace_id<>h.workspace_id OR si.workspace_id<>h.workspace_id)
      OR d.depth=4 AND ${inherits('d')}
    )) AND ${conversationAgentGuard}`;
  const notification = questionNotificationVisibilitySql(db, access, 'notification');
  return { cte, cteParams: source.params, where: `${where} AND NOT EXISTS (SELECT 1 FROM ancestors notification
    WHERE notification.root_id=m.id AND NOT (${notification.where}))`, params: [...params, ...notification.params] };
}
