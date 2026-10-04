import type { SqlDatabase } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
import { tableExists } from '../unified-model-migration.js';

/** Historical tables are consulted once at migration, never by runtime readers. */
export function foldDecisionRecords(db:SqlDatabase):void {
  const migration='20261005_fold_decision_records';
  if(db.query('SELECT id FROM multiremi_schema_migrations WHERE id=?').get(migration))return;
  db.transaction(()=>{
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_card_token ON multiremi_conversation_log(card_token_hash) WHERE card_token_hash IS NOT NULL');
    const insert=(id:string,sessionId:string,taskId:string|null,senderId:string|null,recipientAgent:string|null,recipientMember:string|null,
      body:string,options:unknown,record:Record<string,unknown>,key:string)=>{
      if(!db.query('SELECT session_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId))
        db.run('INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at) VALUES(?,0,0,?)',[sessionId,nowIso()]);
      const existing=db.query('SELECT id FROM multiremi_conversation_log WHERE id=?').get(id);
      const at=String(record.created_at??nowIso());
      const {token_hash,token_recipient,token_consumed_at,...content}=record;
      const metadata=JSON.stringify({[key]:content});
      const resolved=['pending','escalated'].includes(String(record.status))?null:record.responded_at??record.answered_at??at;
      if(existing){db.run(`UPDATE multiremi_conversation_log SET metadata=?,card_token_hash=?,card_token_recipient=?,card_token_consumed_at=?,resolved_at=? WHERE id=?`,
        [metadata,record.token_hash??null,record.token_recipient??null,record.token_consumed_at??null,resolved,id]);return;}
      const head=db.query('UPDATE multiremi_conversation_heads SET head_seq=head_seq+1,log_version=log_version+1 WHERE session_id=? RETURNING head_seq').get(sessionId);
      db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,sender_id,task_id,body_md,metadata,created_at,updated_at,
        to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,options,card_token_hash,card_token_recipient,card_token_consumed_at,resolved_at)
        VALUES(?,?,?,'message','shown',?,?,?, ?,?,?,?, ?,?,?,?,'decision','inbox_only','inbox_only','migration',?,?,?,?,?)`,
        [sessionId,head.head_seq,id,senderId?'agent':'platform',senderId,taskId,body,metadata,at,at,
          recipientMember?'member':recipientAgent?'agent':'none',recipientMember??recipientAgent,recipientAgent,recipientMember,
          options?JSON.stringify(options):null,record.token_hash??null,record.token_recipient??null,record.token_consumed_at??null,resolved]);
    };
    if(tableExists(db,'multiremi_task_human_requests'))for(const row of db.query('SELECT * FROM multiremi_task_human_requests').all()){
      const turn=db.query('SELECT t.* FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id=?').get(row.task_id);
      if(!turn)throw new Error(`Historical question ${row.id} has no turn`);
      const member=db.query("SELECT id FROM multiremi_workspace_members WHERE workspace_id=? AND role='owner' AND archived_at IS NULL ORDER BY id LIMIT 1").get(turn.workspace_id);
      const payload=JSON.parse(row.payload??'{}');
      insert(row.id,turn.session_id,turn.id,turn.agent_id,null,member?.id??null,JSON.stringify(payload),null,{...row,payload,response:row.response?JSON.parse(row.response):null},'human_request');
    }
    if(tableExists(db,'multiremi_issue_decisions'))for(const row of db.query('SELECT * FROM multiremi_issue_decisions').all()){
      const session=db.query('SELECT id FROM multiremi_issue_sessions WHERE issue_id=? ORDER BY is_default DESC,created_at,id LIMIT 1').get(row.issue_id);
      if(!session)throw new Error(`Historical decision ${row.id} has no conversation`);
      const member=db.query("SELECT id FROM multiremi_workspace_members WHERE workspace_id=? AND role='owner' AND archived_at IS NULL ORDER BY id LIMIT 1").get(row.workspace_id);
      const turn=row.source_task_id?db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(row.source_task_id):null;
      const options=JSON.parse(row.options??'[]').map((option:any,i:number)=>typeof option==='string'?{value:`option_${i}`,label:option}:option);
      insert(row.id,session.id,turn?.turn_id??null,row.created_by_agent_id,row.status==='pending'?row.owner_agent_id:null,row.status==='escalated'?member?.id??null:null,
        [row.title,row.body].filter(Boolean).join('\n\n'),options,{...row,answer:row.answer?JSON.parse(row.answer):null,history:JSON.parse(row.history??'[]')},'decision_record');
    }
    db.run('INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?)',[migration,nowIso()]);
  })();
}
