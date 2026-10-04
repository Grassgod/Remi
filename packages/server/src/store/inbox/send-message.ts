import type { MessageHeader, SendMessageInput, SendMessageResult, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import type { CommitEventQueue, StoreContext } from '../context.js';
import { createId } from '@multiremi/ids.js';
import { clampEnvelopeBody } from '../envelope-body.js';
import { countDelegationPairHops, pairRoundTripLimit, DelegationRoundTripLimitError } from '../repos/tasks-repo.js';
import { resolveWake } from './wake-policy.js';
import { ensurePendingTurn } from './lane-machine.js';
import { parseJson } from '../helpers.js';

export function getMessage(ctx:StoreContext,id:string):UnifiedMessage|null {
  const row=ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'").get(id);
  const entry=row?ctx.conversationLog().getConversationLogEntryById(id):null;
  if(!row||!entry)return null;
  const {author_type,author_id,parent_id,...base}=entry;
  return {...base,kind:'message',sender_type:row.sender_type,sender_id:row.sender_id,
    to_type:row.to_type,to_ref:row.to_ref,to_agent_id:row.to_agent_id,to_member_id:row.to_member_id,
    message_kind:row.message_kind,wake_requested:row.wake_requested,wake_applied:row.wake_applied,wake_reason:row.wake_reason,
    reply_to_id:row.reply_to_id,dedupe_key:row.dedupe_key,options:parseJson(row.options,null),
    card_token_hash:row.card_token_hash,card_token_recipient:row.card_token_recipient,card_token_consumed_at:row.card_token_consumed_at};
}

export function sendMessageWithinTransaction(ctx:StoreContext,input:SendMessageInput,events:CommitEventQueue,
  createInput:Partial<CreateTaskInput>={}):SendMessageResult {
  if(!ctx.db.inTransaction)throw new Error('sendMessageWithinTransaction requires a transaction');
  let sessionId=input.session_id;
  const originalSession=ctx.issueSessions().getIssueSession(sessionId);
  const originalChat=ctx.chat().getChatSession(sessionId);
  const auto=ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId);
  const workspaceId=originalSession?.workspaceId??originalChat?.workspaceId??auto?.workspace_id;
  if(!workspaceId)throw new Error('Message conversation not found');
  ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
  const issue=originalSession?ctx.issues().getIssue(originalSession.issueId):null;
  let source=input.source_turn_id?ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(input.source_turn_id):null;
  if(input.source_turn_id&&!source)throw new Error('Source turn not found');
  if(source&&(source.workspace_id!==workspaceId||input.sender.type==='agent'&&source.agent_id!==input.sender.id))throw new Error('Source turn does not belong to the sender workspace');
  if(input.sender.type==='agent'){
    const sender=ctx.agents().getAgent(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId)throw new Error('Message sender belongs to another workspace');
  } else if(input.sender.type==='member'){
    const sender=ctx.workspaces().getWorkspaceMember(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId||sender.archivedAt)throw new Error('Message sender is not an active workspace member');
  }
  const reply=input.reply_to_id?getMessage(ctx,input.reply_to_id):null;
  if(input.reply_to_id&&(!reply||reply.session_id!==input.session_id))throw new Error('Reply target must be a message in this conversation');
  let recipientType:'agent'|'member'|'none'='none',recipientId:string|null=null;
  let targetIssue=issue;
  const owner=(ownerIssue:typeof issue)=>{
    if(!ownerIssue)return;
    if(ownerIssue.assigneeType==='member'){recipientType='member';recipientId=ownerIssue.assigneeId;}
    else if(ownerIssue.assigneeType&&ownerIssue.assigneeId){recipientType='agent';recipientId=ctx.resolveRunnableAgentForAssignee(ownerIssue.assigneeType,ownerIssue.assigneeId)?.id??null;}
  };
  if(input.to.type==='agent'||input.to.type==='member'){recipientType=input.to.type;recipientId=input.to.ref;}
  else if(input.to.type==='role'){
    if(input.to.ref==='issue_owner')owner(issue);
    else if(input.to.ref==='parent_owner'){
      targetIssue=issue?.parentIssueId?ctx.issues().getIssue(issue.parentIssueId):null;owner(targetIssue);
      if(targetIssue)sessionId=ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(targetIssue.id).id;
    } else if(input.to.ref==='delegator'){
      if(reply?.sender_type==='agent'){recipientType='agent';recipientId=reply.sender_id;}
      else if(source?.delegated_by_agent_id){recipientType='agent';recipientId=source.delegated_by_agent_id;
        sessionId=source.delegated_from_issue_session_id??sessionId;targetIssue=ctx.issueSessions().getIssueSession(sessionId)?ctx.issues().getIssue(ctx.issueSessions().getIssueSession(sessionId)!.issueId):null;}
    } else if(input.to.ref==='leader'){
      const squad=ctx.db.query(`SELECT s.leader_id FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id
        WHERE m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL ORDER BY s.id LIMIT 1`).get(input.sender.id,workspaceId);
      recipientType='agent';recipientId=squad?.leader_id??null;
    } else if(input.to.ref==='relay'){recipientType='agent';recipientId=originalChat?.agentId??null;}
  }
  const targetAgent=recipientType==='agent'&&recipientId?ctx.agents().getAgent(recipientId):null;
  const member=recipientType==='member'&&recipientId?ctx.workspaces().getWorkspaceMember(recipientId):null;
  if(targetAgent&&targetAgent.workspaceId!==workspaceId||member&&member.workspaceId!==workspaceId)throw new Error('Message recipient belongs to another workspace');
  // Serializing before dedupe makes a repeated message an idempotent result across PG instances.
  const table=originalSession||sessionId.startsWith('ises_')?'multiremi_issue_sessions':originalChat?'multiremi_chat_sessions':null;
  if(table)ctx.db.run(`UPDATE ${table} SET updated_at=updated_at WHERE id=?`,[sessionId]);
  if(!ctx.conversationLog().getConversationLogHead(sessionId))ctx.conversationLog().ensureConversationLogHead(sessionId,{bodyMd:''});
  ctx.db.run('UPDATE multiremi_conversation_heads SET updated_at=updated_at WHERE session_id=?',[sessionId]);
  const duplicate=input.dedupe_key?ctx.db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND dedupe_key=?').get(sessionId,input.dedupe_key):null;
  if(duplicate){const message=getMessage(ctx,duplicate.id)!;const turn=ctx.db.query('SELECT id FROM multiremi_turns WHERE trigger_message_id=?').get(message.id);
    return {message,wake_applied:message.wake_applied,wake_reason:message.wake_reason,...(turn?{turn_id:turn.id}:{})};}
  const sourceSession=source?ctx.issueSessions().getIssueSession(source.session_id):null;
  const limit=pairRoundTripLimit();
  const hop=(id:string)=>{
    const turn=ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id);
    if(!turn)return null;
    const trigger=turn.trigger_message_id?ctx.db.query('SELECT task_id FROM multiremi_conversation_log WHERE id=?').get(turn.trigger_message_id):null;
    return {id:turn.id,agentId:turn.agent_id,workspaceId:turn.workspace_id,createdAt:turn.created_at,
      delegationId:turn.delegation_id,delegatedByAgentId:turn.delegated_by_agent_id,parentTaskId:trigger?.task_id??null};
  };
  const cutoff=source?ctx.db.query("SELECT MAX(created_at) AS at FROM multiremi_conversation_log WHERE session_id=? AND sender_type='member'").get(source.session_id)?.at:null;
  const node=source?hop(source.id):null;
  const hops=node&&recipientId?countDelegationPairHops(node,recipientId,hop,cutoff??null,2*limit):0;
  const isLeader=recipientId&&input.sender.id?!!ctx.db.query(`SELECT 1 FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id
    WHERE s.leader_id=? AND m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL`).get(recipientId,input.sender.id,workspaceId):false;
  const parentOwner=issue?.parentIssueId?ctx.issues().getIssue(issue.parentIssueId):null;
  const parentAgent=parentOwner?.assigneeType&&parentOwner.assigneeId?ctx.resolveRunnableAgentForAssignee(parentOwner.assigneeType,parentOwner.assigneeId):null;
  const policy=resolveWake(input.sender,input.to,input.wake_requested,input.message_kind,{
    recipientType,recipientId,recipientAvailable:recipientType==='agent'?!!targetAgent&&!targetAgent.archivedAt:recipientType==='member'?!!member&&!member.archivedAt:false,
    dependenciesMet:!targetIssue||targetIssue.status!=='backlog'||!!createInput.dependencyForce||ctx.issues().listUnmetPrerequisites(targetIssue.id).length===0,
    sourceSideSession:!!sourceSession&&sourceSession.inheritMode!=='none',sourceHasIssue:input.sender.type==='agent'?!!source?.issue_id:undefined,
    targetHasIssue:!!targetIssue,pairHops:hops,pairLimit:limit,
    isReplyToDelegator:reply?.sender_type==='agent'&&reply.sender_id===recipientId,isLeader:!!isLeader,isParentOwner:parentAgent?.id===recipientId,
  });
  const header:MessageHeader={sender_type:input.sender.type,sender_id:input.sender.id,to_type:input.to.type,
    to_ref:input.to.type==='none'?null:input.to.ref,to_agent_id:recipientType==='agent'?recipientId:null,to_member_id:recipientType==='member'?recipientId:null,
    message_kind:input.message_kind,wake_requested:input.wake_requested,wake_applied:policy.applied,wake_reason:policy.reason,
    reply_to_id:sessionId===input.session_id?input.reply_to_id??null:null,dedupe_key:input.dedupe_key??null,options:input.options??null,
    card_token_hash:null,card_token_recipient:null,card_token_consumed_at:null};
  const body=input.sender.type==='platform'&&['status','report'].includes(input.message_kind)?clampEnvelopeBody(input.body_md):input.body_md;
  const entry=ctx.conversationLog().appendWithinTransaction({sessionId,id:createId(sessionId.startsWith('ises_')?'cmt':'msg'),kind:'message',authorType:input.sender.type,
    authorId:input.sender.id,taskId:source?.id??null,bodyMd:body,parentId:header.reply_to_id,messageHeader:header,
    metadata:{...input.metadata,...(input.execution_scope?{execution_scope:input.execution_scope}:{})}});
  const message=getMessage(ctx,entry.id)!;
  if(recipientType==='member'&&recipientId){
    const at=entry.created_at;
    ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
      VALUES(?,'member',?,'',?,?) ON CONFLICT DO NOTHING`,[sessionId,recipientId,at,at]);
  }
  const scope=input.execution_scope??'';
  if(recipientType==='agent'&&recipientId){
    // A downgraded message remains discoverable, but only now contributes a wake hint.
    if(policy.applied==='now'){
      ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
        VALUES(?,'agent',?,?,?,?) ON CONFLICT DO NOTHING`,[sessionId,recipientId,scope,entry.created_at,entry.created_at]);
      ctx.db.run(`UPDATE multiremi_session_lanes SET wake_hint_seq=CASE WHEN wake_hint_seq<? THEN ? ELSE wake_hint_seq END
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[entry.seq,entry.seq,sessionId,recipientId,scope]);
    }
  }
  if(policy.reason==='pair_round_trip_limit'&&source?.current_attempt_id&&targetIssue&&recipientId){
    const sourceTask=ctx.tasks().getTask(source.current_attempt_id)!;
    ctx.tasks().recordDelegationRoundTripLimitedWithinTransaction(new DelegationRoundTripLimitError(sourceTask,recipientId,targetIssue.id,hops,limit),[],events);
  }
  let turnInput=createInput;
  if(policy.reason==='agent_dispatch'&&source?.issue_id&&sourceSession){
    turnInput={...createInput,delegationId:createInput.delegationId??createId('dlg'),delegatedByAgentId:input.sender.id,
      delegatedFromIssueSessionId:sourceSession.id,parentTaskId:null};
  }
  const turnId=ensurePendingTurn(ctx,message,{...input,session_id:sessionId},events,turnInput);
  if(policy.applied!==input.wake_requested&&targetIssue)ctx.appendIssueActivity(targetIssue.id,{actorType:'system',actorId:null,type:'wake_downgraded',
    body:policy.reason,data:{message_id:message.id,requested:input.wake_requested,applied:policy.applied,reason:policy.reason}},events);
  return {message,wake_applied:policy.applied,wake_reason:policy.reason,...(turnId?{turn_id:turnId}:{})};
}
