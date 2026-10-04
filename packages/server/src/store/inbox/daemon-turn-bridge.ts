import { attemptInputState,acknowledgeAttemptInput } from './attempt-input.js';
import type { StoreContext,CommitEventQueue } from '../context.js';
import { createCommitEventQueue } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import type { MultiremiTaskWithAgent } from '@multiremi/contracts/types.js';
import type { DaemonTaskCompletionFields } from '@multiremi/contracts/daemon-protocol.js';
import type { UnifiedMessage,DecisionOption } from '@multiremi/contracts/unified-model.js';
import { sendMessageWithinTransaction,getMessage } from './send-message.js';
import { lockLane,acknowledgeInput,assertOfferedInputRead } from './lane-machine.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { patchDecisionRecord } from './decision-records.js';
import { nowIso } from '@multiremi/ids.js';
import { taskSessionInput } from '../task-session-input.js';
import { TRIGGER_MESSAGE_INLINE_CHARS, expandHint } from '@multiremi/contracts/session-input.js';

// Structurally identical to S3's transport interface, without coupling the store to API routers.
export interface DaemonTurnScope {runtimeId:string;daemonId:string;workspaceId:string}
export type DaemonTurnRpc='turn.input'|'turn.decision'|'turn.decision.get'|'turn.decision.expire';
export interface DaemonTurnInput {turn_id:string;attempt_id:string;input_from_seq:number;input_to_seq:number;input_messages:UnifiedMessage[]}
export interface DaemonTurnCompletePayload {turn_id:string;attempt_id:string;input_to_seq:number;reply:{body_md:string;message_kind:'reply'|'final'};session_id?:string|null;work_dir?:string|null}
export class DaemonTurnBridge {
  constructor(private ctx:StoreContext){}
  private transaction<T>(fn:(events:CommitEventQueue)=>T):T {const events=createCommitEventQueue();const result=this.ctx.db.transaction(()=>fn(events))();afterCommit(this.ctx.db,()=>this.ctx.emitCommitEvents(events));return result;}
  private authorized(turnId:string,attemptId:string,scope:DaemonTurnScope,terminal=false):any {
    this.ctx.lockWorkspaceRuntimeLifecycle(scope.workspaceId);
    const row=this.ctx.db.query('SELECT t.*,a.runtime_id,a.status AS attempt_status,a.projection_to_seq AS offered_to FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE t.id=? AND a.id=?').get(turnId,attemptId);
    const runtime=this.ctx.runtimes().getRuntime(scope.runtimeId);
    if(!row||row.current_attempt_id!==attemptId||row.workspace_id!==scope.workspaceId||row.runtime_id!==scope.runtimeId||runtime?.daemonId!==scope.daemonId
      ||!terminal&&!['running','awaiting_human'].includes(row.status))throw new Error('stale_attempt');
    lockLane(this.ctx,row.session_id,row.agent_id,row.execution_scope);return row;
  }
  private messages(sessionId:string,from:number,to:number):UnifiedMessage[]{return this.ctx.db.query("SELECT id FROM multiremi_conversation_log WHERE session_id=? AND seq>? AND seq<=? AND kind='message' AND deleted_at IS NULL AND visibility='shown' ORDER BY seq").all(sessionId,from,to).map(row=>getMessage(this.ctx,row.id)!);}
  private inputMessages(turn:any,from:number,to:number):UnifiedMessage[] {
    const messages=this.messages(turn.session_id,from,to);
    const attempt=this.ctx.db.query('SELECT session_id,attempt_no,input_trigger_ack FROM multiremi_turn_attempts WHERE id=?').get(turn.current_attempt_id);
    // A cold provider needs the original task even when the reader has already
    // acknowledged it. Supply it separately from the unread interval.
    if(Number(attempt.attempt_no)>1&&!attempt.session_id&&!attempt.input_trigger_ack){
      const replayTo=Math.min(from,Number(turn.input_to_seq??turn.wake_seq));
      const replay=this.messages(turn.session_id,Number(turn.input_from_seq??0),replayTo);
      messages.unshift(...replay);
    }
    return messages;
  }
  private cursor(turn:any):number {
    return attemptInputState(this.ctx,turn).ack;
  }
  /** Offers carry receipts for every visible message, but only inline triggering bodies.
   * The original bodies remain in the log and range reads own partial-body progress. */
  private project(messages:UnifiedMessage[],turn:any,from:number,to:number):UnifiedMessage[] {
    const triggers=new Set(messages.filter(m=>m.to_agent_id===turn.agent_id&&m.wake_applied==='now'&&(m.metadata.execution_scope??'')===turn.execution_scope).map(m=>m.seq));
    const entries=messages.map(m=>({...m,author_type:m.sender_type,author_id:m.sender_id,parent_id:m.reply_to_id}));
    const range=taskSessionInput({sessionId:turn.session_id,agentId:turn.agent_id,fromSeq:from,toSeq:to,entries,triggerSeqs:triggers,coldStart:from===0}).split('\n')[0]!.replaceAll('remi session log get','remi message list');
    return messages.map((message,index)=>{
      let body=triggers.has(message.seq)?message.body_md:'';
      const omitted=Math.max(0,body.length-TRIGGER_MESSAGE_INLINE_CHARS);
      if(omitted)body=body.slice(0,TRIGGER_MESSAGE_INLINE_CHARS)+'\n'+expandHint(omitted,`remi message list ${turn.session_id} --from ${message.seq-1} --to ${message.seq}`);
      return {...message,body_md:(index===0?range+'\n'+(message.seq<=from?`原始输入：remi message list ${turn.session_id} --from ${Number(turn.input_from_seq??0)} --to ${from}\n`:''):'')+body,body_html:null,metadata:{execution_scope:turn.execution_scope},
        options:null,card_token_hash:null,card_token_recipient:null,card_token_consumed_at:null};
    });
  }
  offerInput(attempt:MultiremiTaskWithAgent):DaemonTurnInput {
    return this.transaction(()=>{
      this.ctx.lockWorkspaceRuntimeLifecycle(attempt.workspaceId);
      const turn=this.ctx.db.query('SELECT t.* FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id=? AND t.current_attempt_id=a.id').get(attempt.id);
      if(!turn)throw new Error('stale_attempt');lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const from=this.cursor(turn),to=this.ctx.conversationLog().getConversationLogHead(turn.session_id)?.headSeq??from;
      this.ctx.db.run('UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<? THEN ? ELSE projection_to_seq END WHERE id=?',[to,to,attempt.id]);
      return {turn_id:turn.id,attempt_id:attempt.id,input_from_seq:from,input_to_seq:to,input_messages:this.project(this.inputMessages(turn,from,to),turn,from,to)};
    });
  }
  snapshot(scope:DaemonTurnScope,activeAttemptIds:ReadonlySet<string>) {
    return this.transaction(()=>{
      const messages:Array<{turn_id:string;attempt_id:string;message:UnifiedMessage}>=[],wrapUps:Array<{turn_id:string;attempt_id:string;requested_at:string}>=[];
      for(const id of activeAttemptIds){const turn=this.ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(id);if(!turn)continue;
        let row:any;try{row=this.authorized(turn.turn_id,id,scope);}catch{continue;}
        const head=this.ctx.conversationLog().getConversationLogHead(row.session_id)?.headSeq??0;
        const from=this.cursor(row);
        const interrupts=this.messages(row.session_id,from,head).filter(m=>m.wake_applied==='now'&&m.to_agent_id===row.agent_id
          &&(m.metadata.execution_scope??'')===row.execution_scope&&m.seq>Number(row.wake_seq));
        for(const message of this.project(interrupts,row,from,head))messages.push({turn_id:row.id,attempt_id:id,message});
        this.ctx.db.run('UPDATE multiremi_turn_attempts SET projection_to_seq=CASE WHEN COALESCE(projection_to_seq,0)<? THEN ? ELSE projection_to_seq END WHERE id=?',[head,head,id]);
        if(row.wrap_up_requested_at)wrapUps.push({turn_id:row.id,attempt_id:id,requested_at:row.wrap_up_requested_at});
      }
      return {messages,wrapUps};
    });
  }
  rpc(type:DaemonTurnRpc,payload:Record<string,unknown>,scope:DaemonTurnScope):Record<string,unknown> {
    try{return this.transaction(events=>{
      const turn=this.authorized(String(payload.turn_id),String(payload.attempt_id),scope);
      if(type==='turn.input'){
        const to=Number(payload.input_to_seq),from=this.cursor(turn);
        if(!Number.isSafeInteger(to)||to<0||to>Number(turn.offered_to??0)||!Array.isArray(payload.message_ids))throw new Error('input_gap');
        const replay=this.ctx.db.query('SELECT input_trigger_ack,attempt_no,session_id FROM multiremi_turn_attempts WHERE id=?').get(turn.current_attempt_id);
        if(to>from||Number(replay.attempt_no)>1&&!replay.session_id&&!replay.input_trigger_ack){const expected=this.inputMessages(turn,from,to).map(message=>message.id);
          if(JSON.stringify(expected)!==JSON.stringify(payload.message_ids))throw new Error('input_gap');
          assertOfferedInputRead(this.ctx,turn,to);}
        acknowledgeInput(this.ctx,turn.id,Math.min(from,to),to);
        acknowledgeAttemptInput(this.ctx,turn,to);
        return {ok:true,input_to_seq:Math.max(from,to)};
      }
      if(type==='turn.decision'){
        if(typeof payload.body_md!=='string'||typeof payload.dedupe_key!=='string'||!Array.isArray(payload.options))throw new Error('invalid_report');
        const member=this.ctx.workspaces().listWorkspaceMembers(scope.workspaceId).find(m=>m.role==='owner');if(!member)throw new Error('recipient_unavailable');
        const timeout=Number(payload.timeout_ms??0),expires=timeout>0?new Date(Date.now()+timeout).toISOString():null;
        const result=sendMessageWithinTransaction(this.ctx,{session_id:turn.session_id,sender:{type:'agent',id:turn.agent_id},source_turn_id:turn.id,to:{type:'member',ref:member.id},
          body_md:payload.body_md,message_kind:'decision',wake_requested:'now',dedupe_key:payload.dedupe_key,options:payload.options as DecisionOption[],
          metadata:{...(payload.metadata as object),human_request:{kind:(payload.metadata as any)?.kind??'question',payload:{...(payload.metadata as object),options:payload.options},status:'pending',expires_at:expires}}},events);
        return {ok:true,message:result.message,message_id:result.message.id};
      }
      const message=getMessage(this.ctx,String(payload.message_id));if(!message||message.task_id!==turn.id||message.message_kind!=='decision')throw new Error('invalid_report');
      if(type==='turn.decision.expire'){
        if(!['timeout','cancelled'].includes(String(payload.status)))throw new Error('invalid_report');
        const key=message.metadata.human_request?'human_request':'decision_record';
        patchDecisionRecord(this.ctx,message.id,key,{status:payload.status==='timeout'?'expired':'cancelled',responded_at:nowIso()},'pending');
        if(turn.waiting_on_message_id===message.id){this.ctx.db.run("UPDATE multiremi_turns SET status='running',waiting_on_message_id=NULL WHERE id=?",[turn.id]);if(turn.issue_id)deriveIssueStatusWithinTransaction(this.ctx,turn.issue_id,events);}
      }
      const current=getMessage(this.ctx,message.id)!;
      const reply=this.ctx.db.query("SELECT id FROM multiremi_conversation_log WHERE reply_to_id=? AND message_kind='reply' AND deleted_at IS NULL ORDER BY seq LIMIT 1").get(message.id);
      return {ok:true,message:current,reply:reply?getMessage(this.ctx,reply.id):null,status:current.resolved_at?'resolved':'pending'};
    });}catch(error){const code=error instanceof Error?error.message:'invalid_report';return {ok:false,code:code==='stale_attempt'?'stale_attempt':code==='input_gap'?'input_gap':'invalid_report',retryable:false};}
  }
  complete(input:{payload:DaemonTurnCompletePayload;completionFields:DaemonTaskCompletionFields|null;traceEventCount?:number},scope:DaemonTurnScope):Record<string,unknown> {
    const p=input.payload;
    try{
      const prior=this.transaction(()=>{const turn=this.authorized(p.turn_id,p.attempt_id,scope,true);
        if(turn.status==='completed')return {ok:true,turn_id:turn.id,reply_message_id:turn.reply_message_id};
        if(!['running','awaiting_human'].includes(turn.status)||!Number.isSafeInteger(p.input_to_seq)||p.input_to_seq>Number(turn.offered_to??0)||p.input_to_seq<Number(turn.input_to_seq??0))throw new Error('invalid_report');return null;});
      if(prior)return prior;
      this.ctx.tasks().completeTask(p.attempt_id,{output:p.reply.body_md,sessionId:p.session_id,workDir:p.work_dir,completionFields:input.completionFields,traceEventCount:input.traceEventCount,
        turnInputToSeq:p.input_to_seq,replyKind:p.reply.message_kind,expectedRuntimeId:scope.runtimeId,expectedDaemonId:scope.daemonId});
      const turn=this.ctx.db.query('SELECT reply_message_id FROM multiremi_turns WHERE id=?').get(p.turn_id);
      return {ok:true,turn_id:p.turn_id,reply_message_id:turn?.reply_message_id??null};
    }catch(error){
      // A second completion can pass the initial check while the first is committing.
      // Recheck the binding under the same locks before returning its committed result.
      try{const replay=this.transaction(()=>{const turn=this.authorized(p.turn_id,p.attempt_id,scope,true);
        return turn.status==='completed'?{ok:true,turn_id:turn.id,reply_message_id:turn.reply_message_id}:null;});if(replay)return replay;}catch{}
      return {ok:false,code:error instanceof Error&&error.message==='stale_attempt'?'stale_attempt':'invalid_report',retryable:false};
    }
  }
}
