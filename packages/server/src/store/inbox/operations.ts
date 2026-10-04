import type { SendMessageInput, UnifiedMessage, MultiremiTurn, MultiremiTurnAttempt } from '@multiremi/contracts/unified-model.js';
import type { MultiremiWorkspaceMember } from '@multiremi/contracts/types.js';
import type { StoreContext } from '../context.js';
import { createCommitEventQueue } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { createId,nowIso } from '@multiremi/ids.js';
import { getMessage,messageFromRow,sendMessageWithinTransaction } from './send-message.js';
import { normalizeHumanResponse } from './human-response.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { createReplacementAttemptWithinTransaction } from '../turn-attempts.js';
import { notifyTurnChanged } from '../turn-execution-records.js';
import { mintQuestionCardToken,hashQuestionCardToken,type QuestionCardCredential } from '../question-card-token.js';
import { patchDecisionRecord } from './decision-records.js';
import { lockLane } from './lane-machine.js';

type InboxQuery = {limit?:number;cursor?:{created_at:string;id:string};visible?:(sessionId:string)=>boolean;
  visibleMessage?:(message:Pick<UnifiedMessage,'kind'|'task_id'|'metadata'>)=>boolean};

export class InboxOperations {
  constructor(private ctx:StoreContext){}
  private transaction<T>(fn:(events:ReturnType<typeof createCommitEventQueue>)=>T):T {
    const events=createCommitEventQueue();const result=this.ctx.db.transaction(()=>fn(events))();
    afterCommit(this.ctx.db,()=>this.ctx.emitCommitEvents(events));return result;
  }
  listMessages(sessionId:string,input:{from?:number;to?:number;limit?:number;thread?:string;unread_by?:string;message_kind?:string}={}):UnifiedMessage[]{
    const params:unknown[]=[sessionId,input.from??0,input.to??Number.MAX_SAFE_INTEGER];
    const extra=input.thread?' AND (id=? OR reply_to_id=?)':'';if(input.thread)params.push(input.thread,input.thread);
    if(input.message_kind)params.push(input.message_kind);
    if(input.unread_by)params.push(input.unread_by,input.unread_by);
    const scope=this.ctx.db.dialect==='postgres'?"m.metadata::jsonb ->> 'execution_scope'":"json_extract(m.metadata,'$.execution_scope')";
    const unread=input.unread_by?` AND m.to_agent_id=? AND seq>COALESCE((SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=m.session_id AND reader_type='agent' AND reader_id=? AND execution_scope=COALESCE(${scope},'')),0)`:'';
    params.push(Math.min(Math.max(input.limit??100,1),1000));
    return this.ctx.db.query(`SELECT m.* FROM multiremi_conversation_log m WHERE session_id=? AND seq>? AND seq<=?
      AND kind='message' AND visibility='shown' AND deleted_at IS NULL${extra}${input.message_kind?' AND message_kind=?':''}${unread} ORDER BY seq LIMIT ?`).all(...params).map(messageFromRow);
  }
  editMessage(id:string,input:{body_md:string}):UnifiedMessage {
    return this.transaction(()=>{
      const message=getMessage(this.ctx,id);if(!message||message.deleted_at)throw new Error('Message not found');
      this.lockMessage(message);
      this.assertUnread(message);
      this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{body_md:input.body_md}});
      this.ctx.conversationLog().appendWithinTransaction({sessionId:message.session_id,kind:'message_edited',authorType:message.sender_type,authorId:message.sender_id,metadata:{message_id:id}});
      return getMessage(this.ctx,id)!;
    });
  }
  private assertUnread(message:UnifiedMessage):void {
      if(this.ctx.db.query(`SELECT 1 FROM multiremi_turns WHERE session_id=? AND input_to_seq>=? LIMIT 1`).get(message.session_id,message.seq)
        ||this.ctx.db.query(`SELECT 1 FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent'
          AND (cursor_seq>=? OR cursor_seq=? AND cursor_offset>0) LIMIT 1`).get(message.session_id,message.seq,message.seq-1))throw new Error('A consumed message cannot be edited or deleted');
  }
  deleteMessage(id:string):UnifiedMessage {
    return this.transaction(events=>{
      const message=getMessage(this.ctx,id);if(!message)throw new Error('Message not found');this.lockMessage(message);
      if(!message.deleted_at){this.assertUnread(message);this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{deleted_at:nowIso()}});
        this.ctx.conversationLog().appendWithinTransaction({sessionId:message.session_id,kind:'message_deleted',authorType:message.sender_type,authorId:message.sender_id,metadata:{message_id:id}});}
      const issue=this.ctx.issueSessions().getIssueSession(message.session_id);if(issue)deriveIssueStatusWithinTransaction(this.ctx,issue.issueId,events);
      return getMessage(this.ctx,id)!;
    });
  }
  resolveMessage(id:string,actor:{type:string;id:string|null},resolved=true):UnifiedMessage {
    return this.transaction(events=>{
      const message=getMessage(this.ctx,id);if(!message)throw new Error('Message not found');this.lockMessage(message);
      this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{resolved_at:resolved?nowIso():null,resolved_by_type:resolved?actor.type:null,resolved_by_id:resolved?actor.id:null}});
      const session=this.ctx.issueSessions().getIssueSession(message.session_id);if(session)deriveIssueStatusWithinTransaction(this.ctx,session.issueId,events);
      return getMessage(this.ctx,id)!;
    });
  }
  reactMessage(id:string,input:{emoji:string;actorType?:string;actorId?:string;remove?:boolean}) {
    return this.transaction(()=>{const message=getMessage(this.ctx,id);if(!message||message.deleted_at)throw new Error('Message not found');this.lockMessage(message);
      const emoji=input.emoji.trim();if(!emoji)throw new Error('Reaction is required');
      const type=input.actorType??'member',actor=input.actorId??'local';
      if(input.remove)this.ctx.db.run('DELETE FROM multiremi_comment_reactions WHERE comment_id=? AND emoji=? AND actor_type=? AND actor_id=?',[id,emoji,type,actor]);
      else this.ctx.db.run('INSERT INTO multiremi_comment_reactions(id,comment_id,workspace_id,emoji,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[createId('rct'),id,this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(message.session_id)?.workspace_id,emoji,type,actor,nowIso()]);
      return this.ctx.db.query('SELECT * FROM multiremi_comment_reactions WHERE comment_id=? ORDER BY created_at,id').all(id);});
  }
  private lockMessage(message:UnifiedMessage):void {
    const issueSession=this.ctx.issueSessions().getIssueSession(message.session_id),chat=this.ctx.chat().getChatSession(message.session_id);
    const workspace=issueSession?.workspaceId??chat?.workspaceId??this.ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(message.session_id)?.workspace_id??this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(message.session_id)?.workspace_id;
    if(!workspace)throw new Error('Conversation not found');this.ctx.lockWorkspaceRuntimeLifecycle(workspace);
    this.ctx.db.run('UPDATE multiremi_conversation_log SET revision=revision WHERE id=?',[message.id]);
  }
  listMessageInbox(memberId:string,workspaceId:string,input:InboxQuery={}) {
    const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
    return this.listReaderMessageInbox('member',memberId,workspaceId,input);
  }
  listReaderMessageInbox(type:'member'|'agent',readerId:string,workspaceId:string,input:InboxQuery={}) {
    const scope=type==='member'?"''":this.ctx.db.dialect==='postgres'?"COALESCE(m.metadata::jsonb ->> 'execution_scope','')":"COALESCE(json_extract(m.metadata,'$.execution_scope'),'')";
    const json=(key:string)=>this.ctx.db.dialect==='postgres'?`m.metadata::jsonb #>> '{${key.replaceAll('.',',')}}'`:`json_extract(m.metadata,'$.${key}')`;
    const protectedMessage=`CASE WHEN ${json('human_request.kind')} IS NOT NULL OR ${json('human_response')} IS NOT NULL THEN 1 ELSE 0 END`;
    const source=`CASE WHEN ${protectedMessage}=1 THEN COALESCE(m.task_id,q.task_id) ELSE NULL END`;
    const from=`FROM multiremi_conversation_log m
      JOIN multiremi_conversation_heads h ON h.session_id=m.session_id
      LEFT JOIN multiremi_session_lanes l ON l.session_id=m.session_id AND l.reader_type=? AND l.reader_id=? AND l.execution_scope=${scope}
      LEFT JOIN multiremi_conversation_log q ON q.id=m.reply_to_id
      LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=m.session_id
      LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id
      WHERE m.${type==='member'?'to_member_id':'to_agent_id'}=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=? AND m.kind='message'
        AND m.seq>COALESCE(l.cursor_seq,0) AND m.visibility='shown' AND m.deleted_at IS NULL`;
    const params=[type,readerId,readerId,workspaceId];
    const attention=`CASE WHEN m.resolved_at IS NULL AND m.wake_applied<>'inbox_only' AND (
      m.message_kind='decision' OR m.message_kind='request' AND m.sender_type='member'
      OR m.message_kind='status' AND ${json('lifecycle_event')} IN ('task_failed','task_cancelled')
      OR m.message_kind IN ('report','final') AND ${json('message_outcome')} IN ('failed','blocked','cancelled')) THEN 1 ELSE 0 END`;
    const counts=this.ctx.db.query(`SELECT m.session_id,${source} AS source_id,${protectedMessage} AS protected_message,COUNT(*) AS unread_count,SUM(${attention}) AS attention_count
      ${from} GROUP BY m.session_id,${source},${protectedMessage}`).all(...params);
    let unread_count=0,attention_count=0;
    for(const row of counts){
      if(input.visible&&!input.visible(row.session_id))continue;
      if(Number(row.protected_message)&&input.visibleMessage&&!input.visibleMessage({kind:'message',task_id:row.source_id??null,metadata:{human_request:{}}}))continue;
      unread_count+=Number(row.unread_count);attention_count+=Number(row.attention_count);
    }
    const n=Math.min(input.limit??100,1000),items:UnifiedMessage[]=[];
    let cursor=input.cursor;
    for(;;){
      const extra=cursor?' AND (m.created_at<? OR m.created_at=? AND m.id<?)':'';
      const rows=this.ctx.db.query(`SELECT m.* ${from}${extra} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
        .all(...params,...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[]),n+1);
      for(const row of rows){if(input.visible&&!input.visible(row.session_id))continue;const message=messageFromRow(row);
        if(!input.visibleMessage||input.visibleMessage(message))items.push(message);}
      if(rows.length<n+1||items.length>n)break;
      cursor=rows.at(-1) as {created_at:string;id:string};
    }
    const page=items.slice(0,n);
    return {items:page,unread_count,attention_count,next_cursor:items.length>n?{created_at:page.at(-1)!.created_at,id:page.at(-1)!.id}:null};
  }
  readAgentMessageInbox(agentId:string,workspaceId:string,sessionId?:string,toSeq?:number,visible?:(sessionId:string)=>boolean):number {
    return this.transaction(()=>{
      const agent=this.ctx.agents().getAgent(agentId);if(!agent||agent.workspaceId!==workspaceId||agent.archivedAt)throw new Error('Agent belongs to another workspace');
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const json=this.ctx.db.dialect==='postgres'?"m.metadata::jsonb ->> 'execution_scope'":"json_extract(m.metadata,'$.execution_scope')";
      const sessions=this.ctx.db.query(`SELECT DISTINCT m.session_id,COALESCE(${json},'') AS scope FROM multiremi_conversation_log m
        JOIN multiremi_conversation_heads h ON h.session_id=m.session_id WHERE m.to_agent_id=? AND h.workspace_id=?${sessionId?' AND m.session_id=?':''}`)
        .all(agentId,workspaceId,...(sessionId?[sessionId]:[])).filter(row=>!visible||visible(row.session_id));
      if(sessionId){const head=this.ctx.conversationLog().getConversationLogHead(sessionId)?.headSeq??0;
        if(toSeq!==undefined&&(!Number.isSafeInteger(toSeq)||toSeq<0||toSeq>head))throw new Error('Inbox read cursor must be within the log');}
      for(const row of sessions){const head=this.ctx.conversationLog().getConversationLogHead(row.session_id)?.headSeq??0,seq=toSeq??head,at=nowIso();
        lockLane(this.ctx,row.session_id,agentId,row.scope);
        this.ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
          VALUES(?,'agent',?,?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET
          cursor_seq=CASE WHEN multiremi_session_lanes.cursor_seq<excluded.cursor_seq THEN excluded.cursor_seq ELSE multiremi_session_lanes.cursor_seq END,
          cursor_offset=CASE WHEN multiremi_session_lanes.cursor_seq<=excluded.cursor_seq THEN 0 ELSE multiremi_session_lanes.cursor_offset END,updated_at=excluded.updated_at`,[row.session_id,agentId,row.scope,seq,at,at]);}
      this.ctx.emitWorkspaceEvent({type:sessionId?'inbox:read':'inbox:batch-read',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return sessionId?Number(this.ctx.db.query("SELECT MIN(cursor_seq) AS seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=?").get(sessionId,agentId)?.seq??0):new Set(sessions.map(r=>r.session_id)).size;
    });
  }
  readMessageInbox(memberId:string,sessionId:string,toSeq?:number):number {
    return this.transaction(()=>{
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.archivedAt)throw new Error('Member not found');
      this.ctx.lockWorkspaceRuntimeLifecycle(member.workspaceId);
      const cursor=this.readMemberConversation(member,sessionId,toSeq);
      this.ctx.emitWorkspaceEvent({type:'inbox:read',workspaceId:member.workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return cursor;
    });
  }
  private readMemberConversation(member:MultiremiWorkspaceMember,sessionId:string,toSeq?:number):number {
    const session=this.ctx.issueSessions().getIssueSession(sessionId),chat=this.ctx.chat().getChatSession(sessionId),auto=this.ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId);
    if((session?.workspaceId??chat?.workspaceId??auto?.workspace_id??this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id)!==member.workspaceId)throw new Error('Inbox conversation belongs to another workspace');
    const head=this.ctx.conversationLog().getConversationLogHead(sessionId)?.headSeq??0;
    if(toSeq!==undefined&&(!Number.isSafeInteger(toSeq)||toSeq<0||toSeq>head))throw new Error('Inbox read cursor must be within the log');
    const seq=toSeq??head,at=nowIso();
    this.ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
      VALUES(?,'member',?,'',?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope)
      DO UPDATE SET cursor_seq=CASE WHEN multiremi_session_lanes.cursor_seq<excluded.cursor_seq THEN excluded.cursor_seq ELSE multiremi_session_lanes.cursor_seq END,updated_at=excluded.updated_at`,[sessionId,member.id,seq,at,at]);
    return Number(this.ctx.db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id=?").get(sessionId,member.id).cursor_seq);
  }
  readAllMessageInbox(memberId:string,workspaceId:string,visible?:(sessionId:string)=>boolean):number {
    return this.transaction(()=>{
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);
      if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
      const sessions=this.ctx.db.query(`SELECT DISTINCT m.session_id FROM multiremi_conversation_log m
        JOIN multiremi_conversation_heads h ON h.session_id=m.session_id LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=m.session_id
        LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id WHERE m.to_member_id=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=?`).all(memberId,workspaceId).filter(row=>!visible||visible(row.session_id));
      for(const row of sessions)this.readMemberConversation(member,row.session_id);
      this.ctx.emitWorkspaceEvent({type:'inbox:batch-read',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return sessions.length;
    });
  }
  getTurn(id:string):MultiremiTurn|null {
    const row=this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id);return row?{...row,holds_workspace:!!row.holds_workspace} as MultiremiTurn:null;
  }
  listTurns(input:{workspace_id:string;issue_id?:string;session_id?:string;agent_id?:string;status?:string;limit?:number;cursor?:{created_at:string;id:string}}):MultiremiTurn[]{
    const params:unknown[]=[input.workspace_id],conditions=['workspace_id=?'];
    for(const key of ['issue_id','session_id','agent_id','status'] as const)if(input[key]){conditions.push(`${key}=?`);params.push(input[key]);}
    if(input.cursor){conditions.push('(created_at<? OR created_at=? AND id<?)');params.push(input.cursor.created_at,input.cursor.created_at,input.cursor.id);}
    params.push(Math.min(input.limit??100,1000));return this.ctx.db.query(`SELECT id FROM multiremi_turns WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params).map(row=>this.getTurn(row.id)!);
  }
  listTurnAttempts(id:string):MultiremiTurnAttempt[]{
    return this.ctx.db.query('SELECT * FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no').all(id).map(row=>({...row,
      usage:JSON.parse(row.usage??'[]'),plugin_snapshot:JSON.parse(row.plugin_snapshot??'[]'),fallback_switched:!!row.fallback_switched,
      projection_truncated:!!row.projection_truncated,codex_profile:row.codex_profile?JSON.parse(row.codex_profile):null,
      claude_profile:row.claude_profile?JSON.parse(row.claude_profile):null,type_histogram:row.type_histogram?JSON.parse(row.type_histogram):null,
      model:row.model?JSON.parse(row.model):null,trace_ref:row.trace_ref?JSON.parse(row.trace_ref):null} as MultiremiTurnAttempt));
  }
  getTurnTrace(id:string){const turn=this.getTurn(id);if(!turn?.current_attempt_id)throw new Error('Turn not found');
    return {turn_id:id,attempt_id:turn.current_attempt_id,trace:this.ctx.taskTraces().getTaskTrace(turn.current_attempt_id)};}
  getTurnInput(id:string){const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');
    const from=turn.input_from_seq??0,to=turn.input_to_seq??turn.wake_seq,messages:UnifiedMessage[]=[];
    let after=from;
    for(;;){const page=this.listMessages(turn.session_id,{from:after,to,limit:1000});messages.push(...page);if(page.length<1000)break;after=page.at(-1)!.seq;}
    return {from_seq:from,to_seq:to,messages,legacy_prompt:turn.legacy_prompt};}
  cancelTurn(id:string):MultiremiTurn {
    return this.transaction(()=>{const turn=this.getTurn(id);if(!turn?.current_attempt_id)throw new Error('Turn not found');
      if(['completed','failed','cancelled'].includes(turn.status))return turn;
      this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const to=turn.input_to_seq??turn.wake_seq;
      // Cancelling discards this turn's input; it must not ring itself again.
      this.ctx.db.run(`UPDATE multiremi_session_lanes SET cursor_seq=CASE WHEN cursor_seq<? THEN ? ELSE cursor_seq END,
        cursor_offset=CASE WHEN cursor_seq<=? THEN 0 ELSE cursor_offset END WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[to,to,to,turn.session_id,turn.agent_id,turn.execution_scope]);
      this.ctx.tasks().cancelTask(turn.current_attempt_id);return this.getTurn(id)!;});
  }
  wrapUpTurn(id:string):MultiremiTurn {
    return this.transaction(()=>{const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);
      lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      if(!['running','awaiting_human'].includes(turn.status))throw new Error('Only a running turn can wrap up');
      this.ctx.db.run('UPDATE multiremi_turns SET wrap_up_requested_at=COALESCE(wrap_up_requested_at,?) WHERE id=?',[nowIso(),id]);notifyTurnChanged(this.ctx.db,id);
      const task=turn.current_attempt_id?this.ctx.tasks().getTask(turn.current_attempt_id):null;if(task)afterCommit(this.ctx.db,()=>this.ctx.emitWorkspaceEvent({type:'daemon:task_input',workspaceId:turn.workspace_id,actorType:'system',actorId:null,payload:{runtime_id:task.runtimeId,task_id:task.id}}));
      return this.getTurn(id)!;});
  }
  retryTurn(id:string,cold=false):MultiremiTurn {
    return this.transaction(events=>{const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const result=createReplacementAttemptWithinTransaction(this.ctx.db,id,{previousStatus:'cancelled',reason:'manual_retry',cold,allowCancelledTurn:true});
      if(cold)this.ctx.db.run(`UPDATE multiremi_session_lanes SET provider_session_id=NULL,runtime_id=NULL,provider=NULL,work_dir=NULL,execution_fingerprint=NULL
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[turn.session_id,turn.agent_id,turn.execution_scope]);
      const task=this.ctx.tasks().getTask(result.attempt_id);if(task)events.enqueuedTasks.push(task);return this.getTurn(id)!;});
  }
  issueMessageCardToken(id:string,recipient:string|null):string {
    return this.transaction(()=>{const message=getMessage(this.ctx,id);if(!message||message.message_kind!=='decision')throw new Error('Decision not found');this.lockMessage(message);
      const token=mintQuestionCardToken();const changed=this.ctx.db.run(`UPDATE multiremi_conversation_log SET card_token_hash=?,card_token_recipient=?,card_token_consumed_at=NULL WHERE id=? AND resolved_at IS NULL AND card_token_consumed_at IS NULL`,[hashQuestionCardToken(token),recipient,id]);
      if(!changed.changes)throw new Error('Decision is settled');return token;});
  }
  answerMessageDecision(id:string,input:{sender:SendMessageInput['sender'];body_md:string;credential?:QuestionCardCredential;response?:Record<string,unknown>;source_turn_id?:string}) {
    return this.transaction(events=>{const message=getMessage(this.ctx,id);if(!message||message.message_kind!=='decision')throw new Error('Decision not found');this.lockMessage(message);
      const key=message.metadata.human_request?'human_request':'decision_record';
      const record=(message.metadata[key]??{}) as Record<string,unknown>;
      if(message.resolved_at||message.deleted_at||!['pending','escalated'].includes(String(record.status??'pending')))throw new Error('Decision is settled');
      // Domain decisions keep their response projections and lifecycle hooks,
      // while their sole authority and reply still live on message rows.
      if(message.metadata.human_request || message.metadata.decision_record) {
        const before=this.ctx.conversationLog().getConversationLogHead(message.session_id)?.headSeq??0;
        if(message.metadata.human_request) {
          if(input.sender.type!=='member')throw new Error('Decision requires a member answer');
          const request=this.ctx.tasks().getTaskHumanRequest(id);
          const task=request?this.ctx.tasks().getTask(request.taskId):null;
          if(!task || ['completed','failed','cancelled'].includes(task.status))throw new Error('Decision source turn is settled');
          const response=normalizeHumanResponse(request!,input.response??{answer:input.body_md});
          this.ctx.tasks().respondTaskHumanRequest(id,{response,respondedBy:input.sender.id,cardCredential:input.credential});
        } else {
          const session=this.ctx.issueSessions().getIssueSession(message.session_id)!;
          if(input.credential&&!this.ctx.feishuBot().getFeishuIssueDecisionCardContext(session.workspaceId,id)) throw new Error('Decision card context not found');
          if(input.sender.type!=='member'&&input.sender.type!=='agent')throw new Error('Decision requires its recipient');
          const source=input.source_turn_id?this.getTurn(input.source_turn_id):null;
          this.ctx.issues().answerIssueDecision(session.issueId,id,{answer:input.body_md,
            reason:String(input.response?.reason??'Answered through the message API'),overturn:String(input.response?.overturn??'')},
            {type:input.sender.type,id:input.sender.id!,taskId:source?.current_attempt_id??null},{cardCredential:input.credential});
        }
        const reply=this.listMessages(message.session_id,{from:before,limit:1000}).find(m=>m.reply_to_id===id&&m.sender_id===input.sender.id);
        if(!reply)throw new Error('Decision reply was not recorded');
        return {message:reply,wake_applied:reply.wake_applied,wake_reason:reply.wake_reason,
          ...(typeof reply.metadata.delivery_turn_id==='string'?{turn_id:reply.metadata.delivery_turn_id}:{})};
      }
      if(input.sender.type==='member'?message.to_member_id!==input.sender.id:input.sender.type!=='agent'||message.to_agent_id!==input.sender.id)throw new Error('Decision requires its recipient');
      if(!patchDecisionRecord(this.ctx,id,key,{status:'answered',answer:input.body_md,responded_at:nowIso()},undefined,input.credential))throw new Error('Decision is settled');
      return sendMessageWithinTransaction(this.ctx,{session_id:message.session_id,sender:input.sender,to:message.sender_type==='agent'&&message.sender_id?{type:'agent',ref:message.sender_id}:{type:'none'},
        body_md:input.body_md,message_kind:'reply',wake_requested:'now',reply_to_id:id,source_turn_id:input.source_turn_id,
        metadata:input.response?{human_response:input.response}:undefined},events);});
  }
}
