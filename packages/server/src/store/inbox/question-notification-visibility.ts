import type { SqlDatabase } from '../db/postgres.js';
import { questionMetadataText } from './question-indexes.js';
import type { InboxAccess } from './inbox-visibility.js';
type NotificationEntry = { id?: string; kind?: string; session_id?: string; metadata: Record<string, any>;
  to_agent_id?: string | null; visibility?: string; deleted_at?: string | null };
type NotificationIdentity = { workspaceId: string; sourceIssueId: string | null; originalSession: string; humanId: string };

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
    || human?.stage !== 'human' || human.handler?.type !== 'member' || typeof human.handler.id !== 'string') return null;
  return { workspaceId: q.workspace_id, sourceIssueId: q.source_issue_id, originalSession: original.session_id, humanId: human.handler.id };
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
    ag.workspace_id AS agent_workspace,ag.archived_at AS agent_archived
    FROM multiremi_conversation_heads h
    JOIN multiremi_conversation_heads nh ON nh.session_id=?
    LEFT JOIN multiremi_issues source ON source.id=?
    LEFT JOIN multiremi_workspace_members human ON human.id=?
    LEFT JOIN multiremi_turns own ON own.current_attempt_id=?
    LEFT JOIN multiremi_agents ag ON ag.id=own.agent_id WHERE h.session_id=?`,
    params: [identity.workspaceId, access.userId, access.userId, entry.session_id, identity.sourceIssueId, identity.humanId,
      access.attemptId ?? null, identity.originalSession] };
}

export function canReadQuestionNotificationFacts(identity: NotificationIdentity, entry: NotificationEntry,
  access: InboxAccess, facts: Record<string, any> | null | undefined): boolean {
  if (!facts || facts.original_workspace !== identity.workspaceId || facts.notification_workspace !== identity.workspaceId
    || identity.sourceIssueId && facts.source_workspace !== identity.workspaceId
    || facts.human_id !== identity.humanId || facts.human_workspace !== identity.workspaceId || facts.human_archived) return false;
  if (access.attemptId) return facts.own_attempt === access.attemptId && ['running', 'awaiting_human'].includes(facts.own_status)
    && facts.own_workspace === identity.workspaceId && facts.agent_workspace === identity.workspaceId && !facts.agent_archived
    && facts.own_agent === entry.to_agent_id && facts.own_session === entry.session_id
    && String(facts.own_scope ?? '') === String(entry.metadata.execution_scope ?? '');
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
  const params: unknown[] = [];
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
      AND (admin.user_id=? OR admin.id=?)))`;
  }
  const where = `(NOT COALESCE(${notification},FALSE) OR EXISTS (
    SELECT 1 FROM multiremi_conversation_log q
    JOIN multiremi_conversation_heads qh ON qh.session_id=q.session_id
    JOIN multiremi_workspace_members human ON human.id=${rootText('handler.id')}
      AND human.workspace_id=${workspace} AND human.archived_at IS NULL
    LEFT JOIN multiremi_issues source ON source.id=${text('q', 'question.source_issue_id')}
    WHERE q.id=${text(alias, 'root_question_id')} AND q.kind='message' AND q.visibility='shown' AND q.deleted_at IS NULL
      AND CAST(${text('q', 'question.version')} AS TEXT)='1'
      AND ${text('q', 'question.workspace_id')}=${workspace} AND qh.workspace_id=${workspace}
      AND (${text('q', 'question.source_issue_id')} IS NULL OR source.workspace_id=${workspace})
      AND ${rootText('stage')}='human' AND ${rootText('handler.type')}='member'
      AND CAST(${text('q', 'question.route_revision')} AS TEXT)=CAST(${text(alias, 'question_route_revision')} AS TEXT)
      AND ${actor}))`;
  return { where, params };
}
