import type { StoreContext } from '../context.js';
import type { SqlDatabase } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
import { hashQuestionCardToken,assertQuestionCardToken,QuestionCardTokenError,type QuestionCardCredential } from '../question-card-token.js';

/** Read projections are derived exclusively from decision messages; they own no state. */
export function createDecisionReadProjections(db:SqlDatabase):void {
  const json=(key:string)=>db.dialect==='postgres'?`m.metadata::jsonb #>> '{${key.replaceAll('.',',')}}'`:`json_extract(m.metadata,'$.${key}')`;
  const val=(key:string,fallback:string='NULL')=>`COALESCE(${json(key)},${fallback})`;
  const view=db.dialect==='postgres'?'CREATE OR REPLACE VIEW':'CREATE VIEW IF NOT EXISTS';
  db.exec(`${view} multiremi_message_question_records AS SELECT m.id,t.current_attempt_id AS task_id,
    ${val('human_request.kind',"'question'")} AS kind,${val('human_request.payload',"'{}'")} AS payload,
    ${val('human_request.status',"'pending'")} AS status,m.created_at,${json('human_request.expires_at')} AS expires_at,
    ${json('human_request.response')} AS response,${json('human_request.responded_by')} AS responded_by,
    ${json('human_request.responded_at')} AS responded_at,${json('human_request.reminder_sent_at')} AS reminder_sent_at,
    m.card_token_hash AS token_hash,m.card_token_recipient AS token_recipient,m.card_token_consumed_at AS token_consumed_at
    FROM multiremi_conversation_log m JOIN multiremi_turns t ON t.id=m.task_id
    WHERE m.kind='message' AND m.message_kind='decision' AND ${json('human_request.kind')} IS NOT NULL`);
  db.exec(`${view} multiremi_message_decision_records AS SELECT m.id,s.workspace_id,s.issue_id,
    ${val('decision_record.source_issue_id',val('source_issue_id','s.issue_id'))} AS source_issue_id,
    ${json('decision_record.source_task_id')} AS source_task_id,
    ${val('decision_record.kind',"'other'")} AS kind,${val('decision_record.title','m.body_md')} AS title,
    ${val('decision_record.body','m.body_md')} AS body,m.options,
    ${val('decision_record.status',"'pending'")} AS status,${json('decision_record.owner_agent_id')} AS owner_agent_id,
    m.sender_id AS created_by_agent_id,${json('decision_record.answer')} AS answer,
    ${json('decision_record.answered_by_member_id')} AS answered_by_member_id,
    ${json('decision_record.answered_at')} AS answered_at,${val('decision_record.history',"'[]'")} AS history,
    m.created_at,m.updated_at,${json('decision_record.reminder_sent_at')} AS reminder_sent_at,
    m.card_token_hash AS token_hash,m.card_token_recipient AS token_recipient,m.card_token_consumed_at AS token_consumed_at
    FROM multiremi_conversation_log m JOIN multiremi_issue_sessions s ON s.id=m.session_id
    WHERE m.kind='message' AND m.message_kind='decision' AND ${json('human_request.kind')} IS NULL`);
}

/** CAS and metadata changes are on the message itself, never on a projection. */
export function patchDecisionRecord(ctx:StoreContext,id:string,key:'human_request'|'decision_record',fields:Record<string,unknown>,
  expectedStatus?:string,credential?:QuestionCardCredential):boolean {
  ctx.db.run(`UPDATE multiremi_workspaces SET updated_at=updated_at WHERE id=(SELECT COALESCE(s.workspace_id,c.workspace_id,a.workspace_id) FROM multiremi_conversation_log m LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=m.session_id LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id WHERE m.id=?)`,[id]);
  ctx.db.run('UPDATE multiremi_conversation_log SET revision=revision WHERE id=?',[id]);
  const row=ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id=? AND message_kind='decision'").get(id);
  if(!row)return false;
  const metadata=JSON.parse(row.metadata??'{}'),record=metadata[key]??{};
  if(credential)assertQuestionCardToken({token_hash:row.card_token_hash,token_recipient:row.card_token_recipient,
    token_consumed_at:row.card_token_consumed_at,status:record.status??'pending'},credential,expectedStatus==='escalated'?'escalated':'pending');
  if(expectedStatus&&(record.status??'pending')!==expectedStatus)return false;
  if(fields.reminder_sent_at&&record.reminder_sent_at)return false;
  metadata[key]={...record,...fields};
  const terminal=typeof fields.status==='string'&&!['pending','escalated'].includes(fields.status);
  const at=nowIso();
  const result=ctx.db.run(`UPDATE multiremi_conversation_log SET metadata=?,resolved_at=CASE WHEN ?=1 THEN ? ELSE resolved_at END,
    card_token_consumed_at=CASE WHEN ?=1 THEN ? ELSE card_token_consumed_at END,revision=revision+1,updated_at=?
    WHERE id=? ${credential?'AND card_token_hash=? AND card_token_recipient=? AND card_token_consumed_at IS NULL':''}`,
    [JSON.stringify(metadata),terminal?1:0,at,credential?1:0,at,at,id,...(credential?[hashQuestionCardToken(credential.token),credential.operatorOpenId]:[])]);
  if(credential&&!result.changes)throw new QuestionCardTokenError('token_consumed');
  return result.changes===1;
}
