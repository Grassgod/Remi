import type { SendMessageInput, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import { nowIso } from '@multiremi/ids.js';
import { createCommitEventQueue, type CommitEventQueue, type StoreContext } from '../context.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { TRIGGER_MESSAGE_INLINE_CHARS } from '@multiremi/contracts/session-input.js';
import { afterCommit } from '../db/postgres.js';
import { appendPendingTurnAuditWithinTransaction } from '../pending-turns.js';
import { notifyTurnChanged } from '../turn-execution-records.js';

export function lockLane(ctx: StoreContext, sessionId: string, agentId: string, scope = ''): void {
  const at = nowIso();
  ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
    VALUES(?,'agent',?,?,?,?) ON CONFLICT DO NOTHING`, [sessionId, agentId, scope, at, at]);
  ctx.db.run(`UPDATE multiremi_session_lanes SET updated_at=updated_at
    WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`, [sessionId, agentId, scope]);
}

export function deliverToRunningTurn(ctx: StoreContext, turn: any, message: UnifiedMessage): string {
  appendPendingTurnAuditWithinTransaction(ctx.db, {id:turn.id,issueId:turn.issue_id,workspaceId:turn.workspace_id},
    'message_delivered_running', {message_id:message.id,seq:message.seq,reason:message.wake_reason});
  // S3 snapshots the log after this commit; a lost notification is recovered on reconnect.
  const task = ctx.tasks().getTask(turn.current_attempt_id);
  if (task) afterCommit(ctx.db, () => ctx.emitWorkspaceEvent({type:'daemon:task_input',workspaceId:task.workspaceId,actorType:'system',actorId:null,payload:{runtime_id:task.runtimeId,task_id:task.id}}));
  return turn.id;
}

/** Caller owns workspace/session locks. Every decision takes the same lane mutex as completion. */
export function ensurePendingTurn(ctx: StoreContext, message: UnifiedMessage, input: SendMessageInput,
  events: CommitEventQueue, createInput: Partial<CreateTaskInput> = {}): string | undefined {
  const agentId=message.to_agent_id;
  if (!agentId || message.wake_applied==='inbox_only') return;
  const scope=input.execution_scope??'';
  lockLane(ctx,message.session_id,agentId,scope);
  const active=ctx.db.query(`SELECT * FROM multiremi_turns WHERE session_id=? AND agent_id=? AND execution_scope=?
    AND status IN ('pending','running','awaiting_human') ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at,id`)
    .all(message.session_id,agentId,scope);
  // Policy downgrades do not ring or merge; explicit next-turn still joins existing work.
  if (['pair_round_trip_limit','dependencies_unmet','source_side_session','no_issue_target'].includes(message.wake_reason)) return;
  const pending=active.find(t=>t.status==='pending');
  if (pending) {
    ctx.db.run('UPDATE multiremi_turns SET wake_seq=CASE WHEN wake_seq<? THEN ? ELSE wake_seq END WHERE id=?', [message.seq,message.seq,pending.id]);
    appendPendingTurnAuditWithinTransaction(ctx.db,{id:pending.id,issueId:pending.issue_id,workspaceId:pending.workspace_id},
      'turn_merged',{message_id:message.id,seq:message.seq,reason:message.wake_reason});
    return pending.id;
  }
  if (message.wake_applied!=='now') return;
  const running=active.find(t=>t.status==='running'||t.status==='awaiting_human');
  if (running) return deliverToRunningTurn(ctx,running,message);
  const session=ctx.issueSessions().getIssueSession(message.session_id);
  const chat=ctx.chat().getChatSession(message.session_id);
  const task=ctx.tasks().createTurnForMessageWithinWorkspaceLock({
    ...createInput,agentId,issueId:session?.issueId??createInput.issueId??null,
    issueSessionId:session?.id??null,chatSessionId:chat?.id??null,
    conversationSessionId:message.session_id,
    prompt:message.body_md, wakeSource:message.wake_reason,
    triggerCommentId:session?message.id:null,
    assignmentAuthorType:message.sender_type==='member'?'member':message.sender_type==='agent'?'agent':'system',
    assignmentAuthorId:message.sender_id,
  },[],events,undefined,scope);
  const turn=ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(task.id)!;
  ctx.db.run('UPDATE multiremi_turns SET trigger_message_id=?,wake_seq=? WHERE id=?',[message.id,message.seq,turn.turn_id]);
  appendPendingTurnAuditWithinTransaction(ctx.db,{id:turn.turn_id,issueId:task.issueId,workspaceId:task.workspaceId},
    'turn_created',{message_id:message.id,seq:message.seq,reason:message.wake_reason});
  events.enqueuedTasks.push(task);
  return turn.turn_id;
}

export function reRingAfterTurnEnd(ctx: StoreContext, turnId: string, events: CommitEventQueue): string | undefined {
  const turn=ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(turnId);
  if (!turn || !['completed','failed','cancelled'].includes(turn.status)) return;
  lockLane(ctx,turn.session_id,turn.agent_id,turn.execution_scope);
  const lane=ctx.db.query(`SELECT cursor_seq FROM multiremi_session_lanes
    WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`).get(turn.session_id,turn.agent_id,turn.execution_scope)!;
  const scopeSql=ctx.db.dialect==='postgres'?"COALESCE(metadata::jsonb->>'execution_scope','')":"COALESCE(json_extract(metadata,'$.execution_scope'),'')";
  const raw=ctx.db.query(`SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message'
    AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL AND ${scopeSql}=?
    ORDER BY seq LIMIT 1`).get(turn.session_id,turn.agent_id,Math.max(Number(lane.cursor_seq),Number(turn.input_to_seq??0)),turn.execution_scope);
  if (!raw) return;
  const message=ctx.inbox().getMessage(raw.id)!;
  return ensurePendingTurn(ctx,message,{session_id:turn.session_id,sender:{type:message.sender_type,id:message.sender_id},
    to:{type:'agent',ref:turn.agent_id},message_kind:message.message_kind,wake_requested:'now',body_md:message.body_md,
    execution_scope:turn.execution_scope},events,{delegationId:turn.delegation_id,delegatedByAgentId:turn.delegated_by_agent_id,delegatedFromIssueSessionId:turn.delegated_from_issue_session_id});
}

/** Folded/context bodies need a full CLI range read before a receipt may cross them. */
export function assertOfferedInputRead(ctx:StoreContext,turn:any,toSeq:number):void {
  const read=Number(ctx.db.query("SELECT COALESCE(MAX(cursor_seq),0) AS seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=?").get(turn.session_id,turn.agent_id).seq);
  const entries=ctx.db.query("SELECT id FROM multiremi_conversation_log WHERE session_id=? AND seq>? AND seq<=? AND kind='message' AND visibility='shown' AND deleted_at IS NULL").all(turn.session_id,Math.max(read,Number(turn.input_to_seq??0)),toSeq);
  for(const entry of entries){const m=ctx.inbox().getMessage(entry.id)!;
    if(m.sender_type==='agent'&&m.sender_id===turn.agent_id||!m.body_md)continue;
    if(m.body_md.length>TRIGGER_MESSAGE_INLINE_CHARS||m.to_agent_id!==turn.agent_id||m.wake_applied!=='now'||(m.metadata.execution_scope??'')!==turn.execution_scope)throw new Error('input_gap');
  }
}

export function acknowledgeInput(ctx: StoreContext, turnId:string, fromSeq:number, toSeq:number): void {
  const turn=ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(turnId);
  if (!turn) throw new Error('Turn not found');
  lockLane(ctx,turn.session_id,turn.agent_id,turn.execution_scope);
  const lane=ctx.db.query(`SELECT cursor_seq,cursor_offset FROM multiremi_session_lanes
    WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`).get(turn.session_id,turn.agent_id,turn.execution_scope)!;
  const current=Math.max(Number(lane.cursor_seq),Number(turn.input_to_seq??0));
  const head=ctx.conversationLog().getConversationLogHead(turn.session_id)?.headSeq??0;
  if(!Number.isSafeInteger(fromSeq)||!Number.isSafeInteger(toSeq)||fromSeq>current||toSeq<fromSeq||toSeq>head) throw new Error('Input acknowledgement must be contiguous and bounded by the log head');
  if(toSeq<=Number(turn.input_to_seq??0))return;
  if(toSeq>Number(lane.cursor_seq))ctx.db.run(`UPDATE multiremi_session_lanes SET cursor_seq=?,cursor_offset=0,updated_at=?
    WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[toSeq,nowIso(),turn.session_id,turn.agent_id,turn.execution_scope]);
  ctx.db.run('UPDATE multiremi_turns SET input_from_seq=COALESCE(input_from_seq,?),input_to_seq=? WHERE id=?',[fromSeq,toSeq,turnId]);
  notifyTurnChanged(ctx.db,turnId);
}

export function sweepIdleLanes(ctx:StoreContext,events:CommitEventQueue,limit=50,now=Date.now(),entryLimit=500):import('../re-ring-sweep.js').ReRingSweepResult {
  const lanes=ctx.db.query(`SELECT l.*,h.workspace_id FROM multiremi_session_lanes l JOIN multiremi_conversation_heads h ON h.session_id=l.session_id
    WHERE l.reader_type='agent' AND l.status='active' AND l.wake_hint_seq>l.swept_to_seq
    ORDER BY COALESCE(l.swept_at,''),l.session_id,l.reader_id,l.execution_scope LIMIT ?`).all(limit);
  const result={visited:lanes.length,eligible:0,pageFull:lanes.length===limit,lanes:0,examined:0,rang:0,coalesced:0,errors:0};
  for(const initial of lanes){
    if(!initial.workspace_id)continue;ctx.lockWorkspaceRuntimeLifecycle(initial.workspace_id);lockLane(ctx,initial.session_id,initial.reader_id,initial.execution_scope);
    const lane=ctx.db.query("SELECT * FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?").get(initial.session_id,initial.reader_id,initial.execution_scope);
    const agent=ctx.agents().getAgent(lane.reader_id),session=ctx.issueSessions().getIssueSession(lane.session_id),chat=ctx.chat().getChatSession(lane.session_id);
    const active=ctx.db.query("SELECT 1 FROM multiremi_turns WHERE session_id=? AND agent_id=? AND execution_scope=? AND status IN ('pending','running','awaiting_human') LIMIT 1").get(lane.session_id,lane.reader_id,lane.execution_scope);
    if(active)continue;
    const from=Math.max(Number(lane.cursor_seq),Number(lane.swept_to_seq));
    const head=ctx.conversationLog().getConversationLogHead(lane.session_id)?.headSeq??0;
    if(!agent||agent.archivedAt||session?.status==='archived'||chat?.status==='archived'){
      ctx.db.run("UPDATE multiremi_session_lanes SET swept_to_seq=?,swept_at=? WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?",[head,new Date(now).toISOString(),lane.session_id,lane.reader_id,lane.execution_scope]);continue;}
    const latest=ctx.db.query('SELECT ended_at,created_at FROM multiremi_turns WHERE session_id=? AND agent_id=? AND execution_scope=? ORDER BY created_at DESC,id DESC LIMIT 1').get(lane.session_id,lane.reader_id,lane.execution_scope);
    if(now-Date.parse(latest?.ended_at??latest?.created_at??lane.updated_at)<60_000)continue;
    result.eligible++;result.lanes++;
    const entries=ctx.db.query('SELECT id,seq,kind FROM multiremi_conversation_log WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(lane.session_id,from,entryLimit);result.examined+=entries.length;
    const messages=entries.filter(row=>row.kind==='message').map(row=>ctx.inbox().getMessage(row.id)).filter((m):m is UnifiedMessage=>!!m&&m.wake_applied==='now'&&!m.deleted_at&&m.to_agent_id===lane.reader_id&&(m.metadata.execution_scope??'')===lane.execution_scope);
    try{
      const laneEvents=createCommitEventQueue();
      const rang=ctx.db.transaction(()=>{
        const message=messages[0];
        const turnId=message?ensurePendingTurn(ctx,message,{session_id:lane.session_id,sender:{type:message.sender_type,id:message.sender_id},to:{type:'agent',ref:lane.reader_id},body_md:message.body_md,message_kind:message.message_kind,wake_requested:'now',execution_scope:lane.execution_scope},laneEvents):undefined;
        if(turnId&&session)deriveIssueStatusWithinTransaction(ctx,session.issueId,laneEvents);
        const to=entries.at(-1)?.seq??head;
        ctx.db.run("UPDATE multiremi_session_lanes SET swept_to_seq=?,swept_at=? WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?",[to,new Date(now).toISOString(),lane.session_id,lane.reader_id,lane.execution_scope]);
        return !!turnId;
      })();
      if(rang)result.rang++;
      events.workspace.push(...laneEvents.workspace);events.enqueuedTasks.push(...laneEvents.enqueuedTasks);events.issueActivities.push(...laneEvents.issueActivities);
    }catch{result.errors++;}
  }
  return result;
}
