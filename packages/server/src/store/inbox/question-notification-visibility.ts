import type { SqlDatabase } from '../db/postgres.js';
import { questionMetadataText } from './question-indexes.js';
import type { InboxAccess } from './inbox-visibility.js';
type NotificationEntry = { id?: string; kind?: string; session_id?: string; metadata: Record<string, any>;
  to_agent_id?: string | null; visibility?: string; deleted_at?: string | null };
type NotificationIdentity = { workspaceId: string; sourceIssueId: string | null; originalSession: string; humanId: string | null };

export function questionNotificationIdentity(entry: NotificationEntry, original: NotificationEntry | undefined | null): NotificationIdentity | null {
  const q = original?.metadata.question;
  const human = Array.isArray(q?.route) ? q.route.at(-1) : null;
  if (!(entry.metadata.question_notification === true || entry.metadata.question_present_request === true)
    || !original || original.id !== entry.metadata.root_question_id || original.kind !== 'message'
    || typeof original.session_id !== 'string' || typeof entry.session_id !== 'string'
    || original.visibility !== 'shown' || original.deleted_at
    || q?.version !== 1 || typeof q.workspace_id !== 'string' || !q.workspace_id
    || q.source_issue_id !== null && (typeof q.source_issue_id !== 'string' || !q.source_issue_id)
    || !Number.isSafeInteger(q.route_revision) || q.route_revision < 1 || q.route_revision !== entry.metadata.question_route_revision
    || human?.stage !== 'human' || (human.handler === null ? q.native_user_entry !== true
      : human.handler?.type !== 'member' || typeof human.handler.id !== 'string')) return null;
  return { workspaceId: q.workspace_id, sourceIssueId: q.source_issue_id, originalSession: original.session_id, humanId: human.handler?.id ?? null };
}

/** Plain columns keep the async read pool within its existing function gate. */
export function questionNotificationFactsSql(identity: NotificationIdentity, entry: NotificationEntry, access: InboxAccess) {
  return { sql: `SELECT h.workspace_id AS original_workspace, nh.workspace_id AS notification_workspace,
    source.workspace_id AS source_workspace,human.id AS human_id,human.workspace_id AS human_workspace,
    human.archived_at AS human_archived,human.user_id AS human_user,
    EXISTS (SELECT 1 FROM multiremi_workspace_members admin WHERE admin.workspace_id=? AND admin.archived_at IS NULL
      AND admin.role IN ('owner','admin') AND (admin.user_id=? OR admin.id=?)) AS administrator,
    own.current_attempt_id AS own_attempt,own.agent_id AS own_agent,own.workspace_id AS own_workspace,
    own.status AS own_status,own.session_id AS own_session,own.execution_scope AS own_scope,
    ag.workspace_id AS agent_workspace,ag.archived_at AS agent_archived,
    source_agent.visibility AS source_visibility,source_agent.owner_id AS source_owner,
    source_agent.workspace_id AS source_agent_workspace,source_agent.archived_at AS source_agent_archived,
    source_chat.creator_id AS source_chat_creator,
    EXISTS (SELECT 1 FROM multiremi_feishu_bot_chat_bindings binding WHERE binding.chat_session_id=h.session_id
      AND binding.workspace_id=h.workspace_id) AS source_transport,
    reader.id AS source_reader_id,reader.user_id AS source_reader_user
    FROM multiremi_conversation_heads h
    JOIN multiremi_conversation_heads nh ON nh.session_id=?
    LEFT JOIN multiremi_issues source ON source.id=?
    LEFT JOIN multiremi_workspace_members human ON human.id=?
    LEFT JOIN multiremi_turns own ON own.current_attempt_id=?
    LEFT JOIN multiremi_agents ag ON ag.id=own.agent_id
    LEFT JOIN multiremi_conversation_log original ON original.id=? AND original.session_id=h.session_id
    LEFT JOIN multiremi_agents source_agent ON source_agent.id=original.sender_id
    LEFT JOIN multiremi_chat_sessions source_chat ON source_chat.id=h.session_id
    LEFT JOIN multiremi_workspace_members reader ON reader.workspace_id=h.workspace_id
      AND reader.archived_at IS NULL AND (reader.user_id=? OR reader.id=?)
    WHERE h.session_id=?`,
    params: [identity.workspaceId, access.userId, access.userId,
      entry.session_id, identity.sourceIssueId, identity.humanId, access.attemptId ?? null,
      entry.metadata.root_question_id, access.userId, access.userId, identity.originalSession] };
}

export function canReadQuestionNotificationFacts(identity: NotificationIdentity, entry: NotificationEntry,
  access: InboxAccess, facts: Record<string, any> | null | undefined): boolean {
  if (!facts || facts.original_workspace !== identity.workspaceId || facts.notification_workspace !== identity.workspaceId
    || identity.sourceIssueId && facts.source_workspace !== identity.workspaceId
    || identity.humanId && (facts.human_id !== identity.humanId || facts.human_workspace !== identity.workspaceId || facts.human_archived)) return false;
  if (access.attemptId) return facts.own_attempt === access.attemptId && ['running', 'awaiting_human'].includes(facts.own_status)
    && facts.own_workspace === identity.workspaceId && facts.agent_workspace === identity.workspaceId && !facts.agent_archived
    && facts.own_agent === entry.to_agent_id && facts.own_session === entry.session_id
    && String(facts.own_scope ?? '') === String(entry.metadata.execution_scope ?? '');
  if (!identity.humanId) return !access.userId || access.admin
    || !!facts.administrator
    || !!facts.source_reader_id && facts.source_agent_workspace === identity.workspaceId && !facts.source_agent_archived
      && (!!facts.source_transport || !facts.source_chat_creator || facts.source_chat_creator === facts.source_reader_user || facts.source_chat_creator === facts.source_reader_id)
      && (facts.source_visibility !== 'private' || facts.source_owner === facts.source_reader_user);
  return !access.userId || access.admin || facts.administrator === true || facts.administrator === 1
    || facts.human_user === access.userId || facts.human_id === access.userId;
}

/** The Q grant applies only to this notification, never to its whole lane. */
export function questionNotificationVisibilitySql(db: Pick<SqlDatabase, 'dialect'>, access: InboxAccess,
  alias = 'm', workspace = 'h.workspace_id') {
  const text = (name: string, path: string) => questionMetadataText(db, `${name}.metadata`, path);
  const flag = (path: string) => `CAST(${text(alias, path)} AS TEXT) IN ('true','1')`;
  const notification = `(${flag('question_notification')} OR ${flag('question_present_request')})`;
  const route = text('q', 'question.route');
  const root = db.dialect === 'postgres'
    ? `(CASE WHEN ${route} IS JSON ARRAY THEN ${route}::jsonb ELSE '[]'::jsonb END -> -1)`
    : `(CASE WHEN json_valid(${route}) THEN ${route} ELSE '[]' END)`;
  const rootText = (path: string) => db.dialect === 'postgres' ? `${root} #>> '{${path.replaceAll('.', ',')}}'`
    : `json_extract(${root},'$[#-1].${path}')`;
  const native = `(${rootText('handler.type')} IS NULL AND CAST(${text('q', 'question.native_user_entry')} AS TEXT) IN ('true','1'))`;
  const params: unknown[] = [access.userId, access.userId];
  let actor: string;
  if (access.attemptId) {
    params.push(access.attemptId);
    actor = `EXISTS (SELECT 1 FROM multiremi_turns own JOIN multiremi_agents ag ON ag.id=own.agent_id
      WHERE own.current_attempt_id=? AND own.status IN ('running','awaiting_human')
      AND own.workspace_id=${workspace} AND ag.workspace_id=${workspace} AND ag.archived_at IS NULL
      AND own.agent_id=${alias}.to_agent_id AND own.session_id=${alias}.session_id
      AND COALESCE(own.execution_scope,'')=COALESCE(${text(alias, 'execution_scope')},''))`;
  } else if (!access.userId || access.admin) actor = '1=1';
  else {
    params.push(access.userId, access.userId, access.userId, access.userId);
    actor = `(human.user_id=? OR human.id=? OR EXISTS (SELECT 1 FROM multiremi_workspace_members admin
      WHERE admin.workspace_id=${workspace} AND admin.archived_at IS NULL AND admin.role IN ('owner','admin')
      AND (admin.user_id=? OR admin.id=?)) OR (${native} AND reader.id IS NOT NULL
        AND (source_chat.id IS NULL OR source_chat.creator_id=reader.user_id OR source_chat.creator_id=reader.id
          OR EXISTS (SELECT 1 FROM multiremi_feishu_bot_chat_bindings binding WHERE binding.chat_session_id=qh.session_id AND binding.workspace_id=${workspace}))
        AND source_agent.workspace_id=${workspace} AND source_agent.archived_at IS NULL
        AND (source_agent.visibility<>'private' OR source_agent.owner_id=reader.user_id OR reader.role IN ('owner','admin'))))`;
  }
  // CASE keeps the correlated Q lookup out of ordinary-message reads. An OR
  // lets PostgreSQL plan/evaluate that lookup before the notification flag.
  const where = `(CASE WHEN COALESCE(${notification},FALSE) THEN EXISTS (
    SELECT 1 FROM multiremi_conversation_log q
    JOIN multiremi_conversation_heads qh ON qh.session_id=q.session_id
    LEFT JOIN multiremi_workspace_members human ON human.id=${rootText('handler.id')}
      AND human.workspace_id=${workspace} AND human.archived_at IS NULL
    LEFT JOIN multiremi_workspace_members reader ON reader.workspace_id=${workspace} AND reader.archived_at IS NULL
      AND (reader.user_id=? OR reader.id=?)
    LEFT JOIN multiremi_agents source_agent ON source_agent.id=q.sender_id
    LEFT JOIN multiremi_chat_sessions source_chat ON source_chat.id=q.session_id
    LEFT JOIN multiremi_issues source ON source.id=${text('q', 'question.source_issue_id')}
    WHERE q.id=${text(alias, 'root_question_id')} AND q.kind='message' AND q.visibility='shown' AND q.deleted_at IS NULL
      AND CAST(${text('q', 'question.version')} AS TEXT)='1'
      AND ${text('q', 'question.workspace_id')}=${workspace} AND qh.workspace_id=${workspace}
      AND (${text('q', 'question.source_issue_id')} IS NULL OR source.workspace_id=${workspace})
      AND ${rootText('stage')}='human' AND (${native} OR (${rootText('handler.type')}='member' AND human.id IS NOT NULL))
      AND CAST(${text('q', 'question.route_revision')} AS TEXT)=CAST(${text(alias, 'question_route_revision')} AS TEXT)
      AND ${actor}) ELSE TRUE END)`;
  return { where, params };
}
