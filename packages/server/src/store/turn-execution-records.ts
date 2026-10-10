import { renderMarkdown } from "../render/markdown.js";
/** Read projection for execution consumers; mutations always target normalized tables. */
import type { SqlDatabase, SqlStatement } from "./db/postgres.js";
// Keep offsets: the read-pool scanner intentionally compacts tokens and cannot
// be used to split source SQL into expressions.
function maskSqlLiterals(sql:string):string {
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,m=>' '.repeat(m.length));
}
import { createId, nowIso } from "@multiremi/ids.js";

export class AgentReplyCommentError extends Error {}

const TURN_FIELDS = ["task_kind","agent_id","issue_id","issue_session_generation","holds_workspace","trigger_comment_id",
  "trigger_summary","workspace_id","priority","max_attempts","issue_creation_restricted","delegation_id","delegated_by_agent_id",
  "delegated_from_issue_session_id","delegation_skip_reason","wake_source","assignment_event_id","assignment_source_event_id",
  "runtime_workspace_id","chat_queue_order","requesting_user_name","requesting_user_profile_description","execution_scope",
  "wake_seq","bound_issue_log_to_seq","bound_issue_log_delivered_seq"];
const ATTEMPT_FIELDS = ["id","runtime_id","projection_from_seq","projection_to_seq","projection_mode","projection_degrade_level",
  "projection_truncated","projection_omitted_events","projection_estimated_tokens","error","failure_reason","branch_name","session_id",
  "work_dir","progress_summary","progress_step","progress_total","wait_reason","created_at","updated_at","started_at",
  "inherited_projection_truncated","inherited_projection_omitted_events","inherited_projection_estimated_tokens",
  "inherited_projection_to_seq","inherited_projection_from_seq","inherited_projection_token_budget","inherited_projection_recorded_at",
  "provider","plugin_snapshot","codex_profile","claude_profile","execution_fingerprint","offered_at","accepted_at",
  "execution_model","execution_thinking_level","fallback_switched","switch_reason","next_retry_at"];
const EXTRA_FIELDS: Record<string,string> = {
  turn_id:"t.id", issue_session_id:"CASE WHEN t.session_id LIKE 'ises_%' THEN t.session_id END",
  chat_session_id:"CASE WHEN t.session_id LIKE 'chat_%' THEN t.session_id END", prompt:"COALESCE(t.legacy_prompt,'')",
  attempt:"a.attempt_no", parent_task_id:"(SELECT p.id FROM multiremi_turn_attempts p WHERE p.turn_id=a.turn_id AND p.attempt_no=a.attempt_no-1)",
  continued_from_task_id:"t.continued_from_turn_id",delegation_return_task_id:"t.delegation_return_turn_id",
  result:"(SELECT m.body_md FROM multiremi_conversation_log m WHERE m.id=t.reply_message_id)",
  dispatched_at:"a.accepted_at",completed_at:"CASE WHEN a.status IN ('completed','failed','cancelled','lost') THEN a.ended_at END",
  failed_at:"CASE WHEN a.status IN ('failed','lost') THEN a.ended_at END",cancelled_at:"CASE WHEN a.status='cancelled' THEN a.ended_at END",
  status:`CASE WHEN t.current_attempt_id=a.id AND t.status='awaiting_human' THEN 'awaiting_human'
    WHEN a.status='offered' THEN 'queued' WHEN a.status='accepted' THEN 'dispatched' WHEN a.status='lost' THEN 'failed' ELSE a.status END`,
};

export function createTurnExecutionReadProjection(db: SqlDatabase): void {
  const view=(sql:string)=>db.exec(db.dialect==='postgres'?sql.replace('CREATE VIEW IF NOT EXISTS','CREATE OR REPLACE VIEW'):sql);
  view(`CREATE VIEW IF NOT EXISTS multiremi_agent_lane_records AS
    SELECT l.*,reader_id AS agent_id,last_attempt_id AS last_task_id FROM multiremi_session_lanes l WHERE reader_type='agent'`);
  view(`CREATE VIEW IF NOT EXISTS multiremi_issue_message_records AS
    SELECT l.id,s.issue_id,l.session_id AS issue_session_id,CASE WHEN l.sender_type='platform' THEN 'system' ELSE l.sender_type END AS author_type,l.sender_id AS author_id,
      l.task_id,l.reply_to_id AS parent_id,l.body_md AS body,
      CASE WHEN l.sender_type='platform' THEN 'system' ELSE 'comment' END AS type,
      l.resolved_at,l.resolved_by_type,l.resolved_by_id,l.created_at,l.updated_at
    FROM multiremi_conversation_log l JOIN multiremi_issue_sessions s ON s.id=l.session_id
    WHERE l.kind='message' AND l.visibility='shown' AND l.deleted_at IS NULL`);
  if(db.dialect!=='postgres')db.exec("DROP VIEW IF EXISTS multiremi_chat_message_records");
  view(`CREATE VIEW IF NOT EXISTS multiremi_chat_message_records AS
    SELECT l.id,l.session_id AS chat_session_id,l.task_id,l.body_md AS body,l.seq AS sequence,l.created_at,
      CASE WHEN l.sender_type='agent' THEN 'assistant' WHEN l.sender_type='member' THEN 'user' ELSE 'system' END AS role,
      a.failure_reason AS failure_reason,${db.dialect==='postgres'?"(l.metadata::jsonb->>'elapsed_ms')::bigint":"json_extract(l.metadata,'$.elapsed_ms')"} AS elapsed_ms,0 AS pending_agent_delivery,NULL AS agent_delivery_task_id
    FROM multiremi_conversation_log l LEFT JOIN multiremi_turns t ON t.reply_message_id=l.id LEFT JOIN multiremi_turn_attempts a ON a.id=t.current_attempt_id WHERE l.session_id LIKE 'chat_%' AND l.kind='message' AND l.visibility='shown' AND l.deleted_at IS NULL`);
  view(`CREATE VIEW IF NOT EXISTS multiremi_turn_execution_records AS SELECT
    ${db.dialect==='postgres'?"a.xmin::text || ':' || t.xmin::text":"a.updated_at || ':' || a.status"} AS execution_version,
    ${[...TURN_FIELDS.map(c=>`t.${c} AS ${c}`),...ATTEMPT_FIELDS.map(c=>`a.${c} AS ${c}`),
      ...Object.entries(EXTRA_FIELDS).map(([c,expr])=>`${c==='result' ? (db.dialect==='postgres'
        ? "(SELECT (COALESCE(m.metadata::jsonb->'task_result','{}'::jsonb)||jsonb_build_object('output',m.body_md))::text FROM multiremi_conversation_log m WHERE m.id=t.reply_message_id)"
        : "(SELECT json_patch(COALESCE(json_extract(m.metadata,'$.task_result'),'{}'),json_object('output',m.body_md)) FROM multiremi_conversation_log m WHERE m.id=t.reply_message_id)") : expr} AS ${c}`)].join(",\n")}
    FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id`);
}

export function splitExecutionSql(sql: string, delimiter: string): string[] {
  const mask=maskSqlLiterals(sql).replace(/\s/g,' ');let depth=0,start=0;const parts:string[]=[];
  for(let i=0;i<mask.length;i++){
    if(mask[i]==='(')depth++;else if(mask[i]===')')depth--;
    if(depth===0 && mask.slice(i,i+delimiter.length).toUpperCase()===delimiter.toUpperCase()){
      parts.push(sql.slice(start,i));start=i+delimiter.length;i+=delimiter.length-1;
    }
  }
  parts.push(sql.slice(start));return parts;
}
const messageHooks=new WeakMap<SqlDatabase,(id:string)=>void>();
export function registerExecutionMessageHook(db:SqlDatabase,hook:(id:string)=>void):void{messageHooks.set(db,hook);}
type ExecutionLogMessageInput={senderType?:string;messageKind?:string;metadata?:Record<string,unknown>;visibility?:string;taskId?:string};
const messageWriters=new WeakMap<SqlDatabase,(sessionId:string,id:string,agentId:string,body:string,input:ExecutionLogMessageInput)=>number>();
export function registerExecutionMessageWriter(db:SqlDatabase,writer:(sessionId:string,id:string,agentId:string,body:string,input:ExecutionLogMessageInput)=>number):void {messageWriters.set(db,writer);}
const changeHooks = new WeakMap<SqlDatabase, (turnId:string,created:boolean)=>void>();
export function registerTurnChangeHook(db:SqlDatabase, hook:(turnId:string,created:boolean)=>void):void { changeHooks.set(db,hook); }
export function notifyTurnChanged(db:SqlDatabase,turnId:string,created=false):void { changeHooks.get(db)?.(turnId,created); }
export const executionParameterCount=(sql:string)=>[...maskSqlLiterals(sql).matchAll(/\?/g)].length;
function flatParams(params: unknown[]): unknown[] { return params.length===1 && Array.isArray(params[0]) ? params[0] as unknown[] : params; }
function write(db:SqlDatabase,table:string,id:string,fields:Record<string,unknown>):void{
  const keys=Object.keys(fields);if(!keys.length)return;
  db.run(`UPDATE ${table} SET ${keys.map(k=>`${k}=?`).join(",")} WHERE id=?`,[...keys.map(k=>fields[k]),id]);
}
function attemptStatus(value:unknown):unknown{return value==='queued'?'offered':value==='dispatched'?'accepted':value==='awaiting_human'?'running':value;}
function turnStatus(value:unknown):unknown{return value==='lost'?'failed':value==='queued'?'pending':value==='dispatched'||value==='waiting_local_directory'?'running':value;}

/** The SQL expression belongs to the existing consumer; row selection and field ownership are centralized. */
export function runTurnExecutionMutation(db:SqlDatabase,sql:string,...arguments_:unknown[]):{changes:number;lastInsertRowid:number|bigint;rows:any[]} {
  const params=flatParams(arguments_);
  const run=()=>{
    if(/^\s*INSERT\s+INTO\s+multiremi_turn_execution_records/i.test(sql))return insertExecution(db,sql,params);
    const match=sql.match(/^\s*UPDATE\s+multiremi_turn_execution_records\s+SET\s+([\s\S]+)$/i);
    if(!match)throw new Error("Unsupported execution mutation; use normalized storage");
    const [setAndWhere,returning]=splitExecutionSql(match[1]!," RETURNING ");
    const [assignments,where]=splitExecutionSql(setAndWhere!," WHERE ");
    if(!where)throw new Error("Execution mutation requires an explicit predicate");
    const fields=splitExecutionSql(assignments!,",").map(part=>{
      const assignment=part.trim().match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if(!assignment)throw new Error("Unsupported execution assignment");
      return {key:assignment[1]!,expression:assignment[2]!};
    });
    // Lock work identities before evaluating mutable snapshots. Callers usually
    // already hold W/I/lane locks; this also makes standalone mutations atomic.
    db.run(`UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN
      (SELECT turn_id FROM multiremi_turn_execution_records WHERE ${where})`,params.slice(executionParameterCount(assignments!)));
    const targets=db.query(`SELECT id,turn_id,${fields.map((f,i)=>`(${f.expression}) AS mutation_${i}`).join(",")}
      FROM multiremi_turn_execution_records WHERE ${where}`).all(...params);
    const returned:any[]=[];
    for(const row of targets){
      const turn:Record<string,unknown>={},attempt:Record<string,unknown>={};
      let reply:unknown=undefined;
      for(let i=0;i<fields.length;i++){
        const key=fields[i]!.key,value=row[`mutation_${i}`];
        if(TURN_FIELDS.includes(key))turn[key]=value;
        else if(ATTEMPT_FIELDS.includes(key))attempt[key]=value;
        else if(key==='status'){attempt.status=attemptStatus(value);turn.status=turnStatus(value);}
        else if(key==='attempt')attempt.attempt_no=value;
        else if(key==='prompt')turn.legacy_prompt=value;
        else if(key==='delegation_return_task_id')turn.delegation_return_turn_id=value;
        else if(key==='continued_from_task_id')turn.continued_from_turn_id=value;
        else if(key==='dispatched_at')attempt.accepted_at=value;
        else if(key==='completed_at'||key==='failed_at'||key==='cancelled_at'){if(value!=null){attempt.ended_at=value;turn.ended_at=value;}}
        else if(key==='result')reply=value;
        else if(key==='issue_session_id'||key==='chat_session_id'){if(value!=null)turn.session_id=value;}
        else if(key==='parent_task_id'){if(value!=null)throw new Error("Retry ancestry is represented by turn_id and attempt_no");}
        else throw new Error(`Unowned execution field: ${key}`);
      }
      const current=db.query("SELECT current_attempt_id,session_id,agent_id FROM multiremi_turns WHERE id=?").get(row.turn_id);
      if(attempt.started_at!=null&&current.current_attempt_id===row.id){
        const started=db.query('SELECT started_at FROM multiremi_turns WHERE id=?').get(row.turn_id);
        if(started.started_at==null)turn.started_at=attempt.started_at;
      }
      if(attempt.failure_reason!=null&&turn.ended_at!=null)turn.ended_reason=attempt.failure_reason;
      if(current.current_attempt_id!==row.id){delete turn.status;delete turn.ended_at;}
      if(reply!==undefined && reply!==null && current.current_attempt_id===row.id){
        let payload:any;try{payload=JSON.parse(String(reply));}catch{payload={output:String(reply)};}
        if(typeof payload==='string')payload={output:payload};
        const {output,...provenance}=payload??{};
        let message=db.query("SELECT reply_message_id FROM multiremi_turns WHERE id=?").get(row.turn_id).reply_message_id;
        const staged=!String(current.session_id).startsWith('auto_');
        try {
          if(!message){message=createId(String(current.session_id).startsWith('ises_')?'cmt':'msg');
            appendExecutionLog(db,current.session_id,message,'message',current.agent_id,String(output??''),{
              metadata:{task_result:provenance,...(staged?{pending_completion:true}:{})},visibility:staged?'hidden':'shown',taskId:row.turn_id});turn.reply_message_id=message;}
          else{const rendered=renderMarkdown(String(output??''));db.run('UPDATE multiremi_conversation_log SET body_md=?,body_html=?,render_version=?,revision=revision+1,updated_at=? WHERE id=?',[output??'',rendered.html,rendered.render_version,nowIso(),message]);}
        } catch (error) {
          throw new AgentReplyCommentError(error instanceof Error ? error.message : String(error), { cause: error });
        }
      }
      write(db,"multiremi_turn_attempts",row.id,attempt);
      try { write(db,"multiremi_turns",row.turn_id,turn); }
      catch(error) {
        if(turn.reply_message_id) throw new AgentReplyCommentError(error instanceof Error?error.message:String(error),{cause:error});
        throw error;
      }
      notifyTurnChanged(db,row.turn_id);
      if(returning)returned.push(db.query(`SELECT ${returning} FROM multiremi_turn_execution_records WHERE id=?`).get(row.id));
    }
    return {changes:targets.length,lastInsertRowid:0,rows:returned};
  };
  return db.inTransaction?run():db.transaction(run)();
}

export function turnExecutionMutationStatement(db:SqlDatabase,sql:string):SqlStatement {
  return {
    get:(...params)=>runTurnExecutionMutation(db,sql,...params).rows[0]??null,
    all:(...params)=>runTurnExecutionMutation(db,sql,...params).rows,
    run:(...params)=>runTurnExecutionMutation(db,sql,...params),
    values:(...params)=>runTurnExecutionMutation(db,sql,...params).rows.map(row=>Object.values(row)),
  };
}

export function appendExecutionLog(db:SqlDatabase,sessionId:string,id:string,kind:string,agentId:string,body="",input:{senderType?:string;messageKind?:string;metadata?:Record<string,unknown>;visibility?:string;taskId?:string}={}):number{
  if(kind==='message'){
    const writer=messageWriters.get(db);if(!writer)throw new Error('Execution messages require the canonical inbox writer');
    return writer(sessionId,id,agentId,body,input);
  }
  const at=nowIso();
  db.run(`INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at) VALUES(?,0,0,?) ON CONFLICT(session_id) DO NOTHING`,[sessionId,at]);
  db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,body_md,created_at,updated_at)
    VALUES(?,0,?,'head','shown','platform','',?,?) ON CONFLICT(session_id,seq) DO NOTHING`,[sessionId,`head_${sessionId}`,at,at]);
  const seq=db.query("UPDATE multiremi_conversation_heads SET head_seq=head_seq+1,log_version=log_version+1,updated_at=? WHERE session_id=? RETURNING head_seq").get(at,sessionId).head_seq;
  const rendered=renderMarkdown(body);
  db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,sender_id,task_id,body_md,body_html,render_version,
    message_kind,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[sessionId,seq,id,kind,input.visibility??'shown',input.senderType??'agent',agentId,kind==='turn'?id:input.taskId??null,body,rendered.html,rendered.render_version,input.messageKind??(kind==='turn'?'status':'reply'),JSON.stringify(input.metadata??{}),at,at]);
  return Number(seq);
}
function insertExecution(db:SqlDatabase,sql:string,params:unknown[]):{changes:number;lastInsertRowid:number;rows:any[]}{
  const match=sql.match(/^\s*INSERT\s+INTO\s+multiremi_turn_execution_records\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i);
  if(!match)throw new Error("Unsupported execution insert");
  const names=match[1]!.split(",").map(k=>k.trim());
  const evaluated=db.query(`SELECT ${splitExecutionSql(match[2]!,",").map((v,i)=>`(${v}) AS value_${i}`).join(",")}`).get(...params);
  const input=Object.fromEntries(names.map((name,i)=>[name,evaluated[`value_${i}`]]));
  const parent=input.parent_task_id && Number(input.attempt??1)>1?db.query("SELECT turn_id FROM multiremi_turn_attempts WHERE id=?").get(input.parent_task_id):null;
  const turnId=parent?.turn_id??input.id;
  if(input.parent_task_id&&Number(input.attempt??1)>1&&!parent)throw new Error("Retry parent attempt does not exist");
  if(!parent){
    const auto=db.query('SELECT a.session_id,r.id AS run_id FROM multiremi_autopilots a JOIN multiremi_autopilot_runs r ON r.autopilot_id=a.id WHERE r.turn_id=?').get(input.id);
    const sessionId=input.conversation_session_id??input.issue_session_id??input.chat_session_id??auto?.session_id??`auto_orphan_${input.workspace_id}`;
    // Independent automation runs share a conversation but each has its own
    // execution lane. Existing entry points can queue more than one run.
    if (auto && !input.issue_session_id && !input.chat_session_id && !input.execution_scope) {
      input.execution_scope = `autopilot_run:${auto.run_id}`;
    }
    const seq=appendExecutionLog(db,sessionId,turnId,"turn",input.agent_id);
    const turn:Record<string,unknown>={...Object.fromEntries(TURN_FIELDS.filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),
      id:turnId,session_id:sessionId,seq,status:turnStatus(input.status??"queued"),current_attempt_id:input.id,legacy_prompt:input.prompt,created_at:input.created_at,
      continued_from_turn_id:input.continued_from_task_id??null};
    const keys=Object.keys(turn);db.run(`INSERT INTO multiremi_turns(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`,keys.map(k=>turn[k]));
  }
  const attempt={...Object.fromEntries(ATTEMPT_FIELDS.filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),turn_id:turnId,
    attempt_no:parent?Number(db.query("SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(turnId).n):Number(input.attempt??1),
    status:attemptStatus(input.status??"queued")};
  const keys=Object.keys(attempt);db.run(`INSERT INTO multiremi_turn_attempts(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`,keys.map(k=>(attempt as any)[k]));
  db.run("UPDATE multiremi_turns SET current_attempt_id=?,status=CASE WHEN status IN ('failed','cancelled') THEN 'running' ELSE status END,ended_at=NULL,ended_reason=NULL WHERE id=?",[input.id,turnId]);
  notifyTurnChanged(db,turnId,!parent);
  return {changes:1,lastInsertRowid:0,rows:[]};
}
