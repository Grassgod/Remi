import type { SendMessageInput, UnifiedMessage, MultiremiTurn, MultiremiTurnAttempt } from '@multiremi/contracts/unified-model.js';
import type { StoreContext } from '../context.js';
import { createCommitEventQueue } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { createId,nowIso } from '@multiremi/ids.js';
import { getMessage,sendMessageWithinTransaction } from './send-message.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { createReplacementAttemptWithinTransaction } from '../turn-attempts.js';
import { notifyTurnChanged } from '../turn-execution-records.js';
import { envelopePriority } from '@multiremi/contracts/inbox.js';
import { mintQuestionCardToken,hashQuestionCardToken,type QuestionCardCredential } from '../question-card-token.js';
import { patchDecisionRecord } from './decision-records.js';
import { lockLane } from './lane-machine.js';

export class InboxOperations {
  constructor(private ctx:StoreContext){}
  private transaction<T>(fn:(events:ReturnType<typeof createCommitEventQueue>)=>T):T {
    const events=createCommitEventQueue();const result=this.ctx.db.transaction(()=>fn(events))();
    afterCommit(this.ctx.db,()=>this.ctx.emitCommitEvents(events));return result;
  }
  listMessages(sessionId:string,input:{from?:number;to?:number;limit?:number;thread?:string;unread_by?:string}={}):UnifiedMessage[]{
    const params:unknown[]=[sessionId,input.from??0,input.to??Number.MAX_SAFE_INTEGER];
    const extra=input.thread?' AND (id=? OR reply_to_id=?)':'';if(input.thread)params.push(input.thread,input.thread);
    if(input.unread_by)params.push(input.unread_by);
    const unread=input.unread_by?` AND seq>COALESCE((SELECT MAX(cursor_seq) FROM multiremi_session_lanes WHERE session_id=m.session_id AND reader_type='agent' AND reader_id=?),0)`:'';
    params.push(Math.min(Math.max(input.limit??100,1),1000));
    return this.ctx.db.query(`SELECT id FROM multiremi_conversation_log m WHERE session_id=? AND seq>? AND seq<=?
      AND kind='message' AND deleted_at IS NULL${extra}${unread} ORDER BY seq LIMIT ?`).all(...params).map(row=>getMessage(this.ctx,row.id)!);
  }
  editMessage(id:string,input:{body_md:string}):UnifiedMessage {
    return this.transaction(()=>{
      const message=getMessage(this.ctx,id);if(!message||message.deleted_at)throw new Error('Message not found');
      this.lockMessage(message);
      if(this.ctx.db.query(`SELECT 1 FROM multiremi_turns WHERE session_id=? AND input_to_seq>=? LIMIT 1`).get(message.session_id,message.seq)
        ||this.ctx.db.query(`SELECT 1 FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent'
          AND (cursor_seq>=? OR cursor_seq=? AND cursor_offset>0) LIMIT 1`).get(message.session_id,message.seq,message.seq-1))throw new Error('A consumed message cannot be edited');
      this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{body_md:input.body_md}});
      this.ctx.conversationLog().appendWithinTransaction({sessionId:message.session_id,kind:'message_edited',authorType:message.sender_type,authorId:message.sender_id,metadata:{message_id:id}});
      return getMessage(this.ctx,id)!;
    });
  }
  deleteMessage(id:string):UnifiedMessage {
    return this.transaction(events=>{
      const message=getMessage(this.ctx,id);if(!message)throw new Error('Message not found');this.lockMessage(message);
      if(!message.deleted_at){this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{deleted_at:nowIso()}});
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
  listMessageInbox(memberId:string,workspaceId:string,input:{limit?:number}={}) {
    const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
    const rows=this.ctx.db.query(`SELECT m.id FROM multiremi_conversation_log m
      JOIN multiremi_conversation_heads h ON h.session_id=m.session_id
      LEFT JOIN multiremi_session_lanes l ON l.session_id=m.session_id AND l.reader_type='member' AND l.reader_id=? AND l.execution_scope=''
      LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=m.session_id
      LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id
      WHERE m.to_member_id=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=? AND m.kind='message'
        AND m.seq>COALESCE(l.cursor_seq,0) AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC`)
      .all(memberId,memberId,workspaceId);
    const items=rows.map(row=>getMessage(this.ctx,row.id)!);
    const priority=(message:UnifiedMessage)=>envelopePriority({kind:message.message_kind==='decision'?'decision_needed':message.message_kind==='status'?'lifecycle':message.message_kind,
      wake:message.wake_applied,senderType:message.sender_type,outcome:message.metadata.message_outcome as any,lifecycleEvent:message.metadata.lifecycle_event as string|undefined});
    return {items:items.slice(0,Math.min(input.limit??100,1000)),unread_count:items.length,attention_count:items.filter(m=>!m.resolved_at&&priority(m)<=2).length};
  }
  readMessageInbox(memberId:string,sessionId:string,toSeq?:number):number {
    return this.transaction(()=>{
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.archivedAt)throw new Error('Member not found');
      this.ctx.lockWorkspaceRuntimeLifecycle(member.workspaceId);
      const session=this.ctx.issueSessions().getIssueSession(sessionId),chat=this.ctx.chat().getChatSession(sessionId),auto=this.ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId);
      if((session?.workspaceId??chat?.workspaceId??auto?.workspace_id??this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id)!==member.workspaceId)throw new Error('Inbox conversation belongs to another workspace');
      const head=this.ctx.conversationLog().getConversationLogHead(sessionId)?.headSeq??0;
      if(toSeq!==undefined&&(!Number.isSafeInteger(toSeq)||toSeq<0||toSeq>head))throw new Error('Inbox read cursor must be within the log');
      const seq=toSeq??head,at=nowIso();
      this.ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
        VALUES(?,'member',?,'',?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope)
        DO UPDATE SET cursor_seq=CASE WHEN multiremi_session_lanes.cursor_seq<excluded.cursor_seq THEN excluded.cursor_seq ELSE multiremi_session_lanes.cursor_seq END,updated_at=excluded.updated_at`,[sessionId,memberId,seq,at,at]);
      return Number(this.ctx.db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id=?").get(sessionId,memberId).cursor_seq);
    });
  }
  readAllMessageInbox(memberId:string,workspaceId:string):number {
    return this.transaction(()=>{
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);
      if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
      const sessions=this.ctx.db.query(`SELECT DISTINCT m.session_id FROM multiremi_conversation_log m
        JOIN multiremi_conversation_heads h ON h.session_id=m.session_id LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=m.session_id
        LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id WHERE m.to_member_id=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=?`).all(memberId,workspaceId);
      for(const row of sessions)this.readMessageInbox(memberId,row.session_id);return sessions.length;
    });
  }
  getTurn(id:string):MultiremiTurn|null {
    const row=this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id);return row?{...row,holds_workspace:!!row.holds_workspace} as MultiremiTurn:null;
  }
  listTurns(input:{workspace_id:string;issue_id?:string;session_id?:string;agent_id?:string;limit?:number}):MultiremiTurn[]{
    const params:unknown[]=[input.workspace_id],conditions=['workspace_id=?'];
    for(const key of ['issue_id','session_id','agent_id'] as const)if(input[key]){conditions.push(`${key}=?`);params.push(input[key]);}
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
    return {from_seq:turn.input_from_seq??0,to_seq:turn.input_to_seq??turn.wake_seq,messages:this.listMessages(turn.session_id,{from:turn.input_from_seq??0,to:turn.input_to_seq??turn.wake_seq,limit:1000}),legacy_prompt:turn.legacy_prompt};}
  cancelTurn(id:string):MultiremiTurn {const turn=this.getTurn(id);if(!turn?.current_attempt_id)throw new Error('Turn not found');this.ctx.tasks().cancelTask(turn.current_attempt_id);return this.getTurn(id)!;}
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
  answerMessageDecision(id:string,input:{sender:SendMessageInput['sender'];body_md:string;credential?:QuestionCardCredential}) {
    return this.transaction(events=>{const message=getMessage(this.ctx,id);if(!message||message.message_kind!=='decision')throw new Error('Decision not found');this.lockMessage(message);
      const key=message.metadata.human_request?'human_request':'decision_record';
      const record=(message.metadata[key]??{}) as Record<string,unknown>;
      if(message.resolved_at||message.deleted_at||!['pending','escalated'].includes(String(record.status??'pending')))throw new Error('Decision is settled');
      if(!patchDecisionRecord(this.ctx,id,key,{status:key==='human_request'?'responded':'answered',responded_at:nowIso()},String(record.status??'pending'),input.credential))throw new Error('Decision is settled');
      return sendMessageWithinTransaction(this.ctx,{session_id:message.session_id,sender:input.sender,to:message.sender_type==='agent'&&message.sender_id?{type:'agent',ref:message.sender_id}:{type:'none'},
        body_md:input.body_md,message_kind:'reply',wake_requested:'now',reply_to_id:id},events);});
  }
}
