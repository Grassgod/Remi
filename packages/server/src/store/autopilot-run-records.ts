/** Scheduling ledger projection; execution outcome is read from its turn. */
import type { SqlDatabase } from './db/postgres.js';
import { splitExecutionSql, executionParameterCount, appendExecutionLog } from './turn-execution-records.js';
import { createId, nowIso } from '@multiremi/ids.js';

export function createAutopilotRunReadProjection(db:SqlDatabase):void {
  const columns=db.query('PRAGMA table_info(multiremi_autopilot_runs)').all().map((r:any)=>`r.${r.name}`);
  const result=db.dialect==='postgres'
    ? `COALESCE((m.metadata::jsonb->>'run_result'),jsonb_build_object('taskId',t.current_attempt_id,'issueId',r.issue_id,'output',reply.body_md,'error',a.error)::text)`
    : `COALESCE(json_extract(m.metadata,'$.run_result'),json_object('taskId',t.current_attempt_id,'issueId',r.issue_id,'output',reply.body_md,'error',a.error))`;
  db.exec(`${db.dialect==='postgres'?'CREATE OR REPLACE VIEW':'CREATE VIEW IF NOT EXISTS'} multiremi_autopilot_run_records AS SELECT
    ${columns.join(',')},t.current_attempt_id AS task_id,
    CASE WHEN r.turn_id IS NULL THEN CASE WHEN r.completed_at IS NOT NULL THEN 'skipped' ELSE 'queued' END
      WHEN t.status IN ('pending','running','awaiting_human') THEN 'running'
      WHEN t.status='completed' AND r.failure_reason IS NULL THEN 'completed' ELSE 'failed' END AS status,
    ${result} AS result
    FROM multiremi_autopilot_runs r LEFT JOIN multiremi_turns t ON t.id=r.turn_id
    LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id
    LEFT JOIN multiremi_conversation_log m ON m.id=r.outcome_message_id
    LEFT JOIN multiremi_conversation_log reply ON reply.id=t.reply_message_id`);
}

function normalizedRun(db:SqlDatabase,input:Record<string,any>,previous?:Record<string,any>):Record<string,any> {
  const result={...input};delete result.status;delete result.result;
  if(Object.hasOwn(result,'task_id')){const id=result.task_id;delete result.task_id;
    result.turn_id=id?db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(id)?.turn_id??null:null;}
  if(input.status==='skipped'&&!result.completed_at)result.completed_at=nowIso();
  if(input.result!=null || input.status==='skipped') {
    const run={...previous,...input};
    const auto=db.query('SELECT session_id FROM multiremi_autopilots WHERE id=?').get(run.autopilot_id);
    if(auto){const id=createId('msg');appendExecutionLog(db,auto.session_id,id,'message',run.autopilot_id,
      input.status==='skipped'?String(run.failure_reason??'Skipped'):String(run.failure_reason??'Run outcome'),{
        senderType:'timer',messageKind:'status',metadata:{run_id:run.id,turn_id:result.turn_id??run.turn_id??null,run_result:input.result??null},
      });result.outcome_message_id=id;}
  }
  return result;
}
export function runAutopilotRunMutation(db:SqlDatabase,sql:string,params:unknown[]=[]):{changes:number;lastInsertRowid:number} {
  const run=()=>{
    const insertion=sql.match(/^\s*INSERT(?: OR IGNORE)? INTO multiremi_autopilot_run_records\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i);
    if(insertion){const names=insertion[1]!.split(',').map(k=>k.trim());
      const row=db.query(`SELECT ${splitExecutionSql(insertion[2]!,',').map((v,i)=>`(${v}) AS v${i}`).join(',')}`).get(...params);
      const input=Object.fromEntries(names.map((k,i)=>[k,row[`v${i}`]]));
      // Serialize dedupe under the caller's automation/workspace lock.
      if(db.query('SELECT id FROM multiremi_autopilot_runs WHERE id=? OR (trigger_id=? AND event_id=? AND event_id IS NOT NULL)').get(input.id,input.trigger_id??null,input.event_id??null))return {changes:0,lastInsertRowid:0};
      const value=normalizedRun(db,input);const keys=Object.keys(value);
      const result=db.run(`INSERT ${/OR IGNORE/i.test(sql)?'OR IGNORE ':''}INTO multiremi_autopilot_runs(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(k=>value[k]));
      return {changes:result.changes,lastInsertRowid:0};
    }
    const update=sql.match(/^\s*UPDATE multiremi_autopilot_run_records\s+SET\s+([\s\S]+)$/i);
    if(!update)throw new Error('Unsupported scheduling ledger mutation');
    const [set,where]=splitExecutionSql(update[1]!,' WHERE ');if(!where)throw new Error('Run update needs a predicate');
    const fields=splitExecutionSql(set!,',').map(v=>{const match=v.trim().match(/^(\w+)\s*=\s*([\s\S]+)$/)!;return {key:match[1]!,expression:match[2]!};});
    db.run(`UPDATE multiremi_autopilot_runs SET turn_id=turn_id WHERE id IN(SELECT id FROM multiremi_autopilot_run_records WHERE ${where})`,params.slice(executionParameterCount(set!)));
    const rows=db.query(`SELECT id,autopilot_id,turn_id,failure_reason,${fields.map((f,i)=>`(${f.expression}) AS v${i}`).join(',')} FROM multiremi_autopilot_run_records WHERE ${where}`).all(...params);
    for(const row of rows){const input=Object.fromEntries(fields.map((f,i)=>[f.key,row[`v${i}`]]));const value=normalizedRun(db,input,row);
      const keys=Object.keys(value);if(keys.length)db.run(`UPDATE multiremi_autopilot_runs SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`,[...keys.map(k=>value[k]),row.id]);}
    return {changes:rows.length,lastInsertRowid:0};
  };return db.inTransaction?run():db.transaction(run)();
}
