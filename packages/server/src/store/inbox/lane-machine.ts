import type { SendMessageInput, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import { nowIso } from '@multiremi/ids.js';
import type { CommitEventQueue, StoreContext } from '../context.js';
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
  const raw=ctx.db.query(`SELECT id FROM multiremi_conversation_log WHERE session_id=? AND kind='message'
    AND to_agent_id=? AND seq>? AND wake_applied='now' AND deleted_at IS NULL
    ORDER BY seq LIMIT 1`).get(turn.session_id,turn.agent_id,Math.max(Number(lane.cursor_seq),Number(turn.input_to_seq??0)));
  if (!raw) return;
  const message=ctx.inbox().getMessage(raw.id)!;
  return ensurePendingTurn(ctx,message,{session_id:turn.session_id,sender:{type:message.sender_type,id:message.sender_id},
    to:{type:'agent',ref:turn.agent_id},message_kind:message.message_kind,wake_requested:'now',body_md:message.body_md,
    execution_scope:turn.execution_scope},events);
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
  if(toSeq<=current)return;
  ctx.db.run(`UPDATE multiremi_session_lanes SET cursor_seq=?,cursor_offset=0,updated_at=?
    WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[toSeq,nowIso(),turn.session_id,turn.agent_id,turn.execution_scope]);
  ctx.db.run('UPDATE multiremi_turns SET input_from_seq=COALESCE(input_from_seq,?),input_to_seq=? WHERE id=?',[fromSeq,toSeq,turnId]);
  notifyTurnChanged(ctx.db,turnId);
}

export function sweepIdleLanes(ctx: StoreContext, events:CommitEventQueue, limit=100): number {
  const lanes=ctx.db.query(`SELECT l.* FROM multiremi_session_lanes l WHERE reader_type='agent'
    AND NOT EXISTS(SELECT 1 FROM multiremi_turns t WHERE t.session_id=l.session_id AND t.agent_id=l.reader_id
      AND t.execution_scope=l.execution_scope AND t.status IN ('pending','running','awaiting_human'))
    ORDER BY l.updated_at LIMIT ?`).all(limit);
  let created=0;
  for (const lane of lanes) {
    lockLane(ctx,lane.session_id,lane.reader_id,lane.execution_scope);
    const raw=ctx.db.query(`SELECT id FROM multiremi_conversation_log WHERE session_id=? AND to_agent_id=?
      AND seq>? AND wake_applied='now' AND kind='message' AND deleted_at IS NULL ORDER BY seq LIMIT 1`)
      .get(lane.session_id,lane.reader_id,lane.cursor_seq);
    const message=raw?ctx.inbox().getMessage(raw.id):null;
    if(message&&ensurePendingTurn(ctx,message,{session_id:lane.session_id,sender:{type:message.sender_type,id:message.sender_id},to:{type:'agent',ref:lane.reader_id},
      body_md:message.body_md,message_kind:message.message_kind,wake_requested:'now',execution_scope:lane.execution_scope},events))created++;
  }
  return created;
}
