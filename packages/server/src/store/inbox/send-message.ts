import type { MessageHeader, SendMessageInput, SendMessageResult, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import type { CommitEventQueue, StoreContext } from '../context.js';
import { createId } from '@multiremi/ids.js';
import { clampEnvelopeBody } from '../envelope-body.js';
import { countDelegationPairHops, pairRoundTripLimit, DelegationRoundTripLimitError } from '../repos/tasks-repo.js';
import { resolveWake } from './wake-policy.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { lockLane } from './lane-machine.js';
import { ensurePendingTurn } from './lane-machine.js';
import { parseJson } from '../helpers.js';
import { toConversationLogEntry } from '../repos/conversation-log-repo.js';
import type { MultiremiAgent } from '@multiremi/contracts/types.js';

export function getMessage(ctx:StoreContext,id:string):UnifiedMessage|null {
  const row=ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'").get(id);
  return row ? messageFromRow(row) : null;
}

export function messageFromRow(row: Record<string, any>): UnifiedMessage {
  const entry=toConversationLogEntry(row);
  const {author_type,author_id,parent_id,...base}=entry;
  return {...base,metadata:parseJson(row.metadata,{}),kind:'message',sender_type:row.sender_type,sender_id:row.sender_id,
    to_type:row.to_type,to_ref:row.to_ref,to_agent_id:row.to_agent_id,to_member_id:row.to_member_id,
    message_kind:row.message_kind,wake_requested:row.wake_requested,wake_applied:row.wake_applied,wake_reason:row.wake_reason,
    reply_to_id:row.reply_to_id,dedupe_key:row.dedupe_key,options:parseJson(row.options,null),
    card_token_hash:row.card_token_hash,card_token_recipient:row.card_token_recipient,card_token_consumed_at:row.card_token_consumed_at};
}

export function countMessageDelegationPairHops(ctx:StoreContext,sourceId:string,targetId:string,limit=pairRoundTripLimit()):number {
  const source=ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(sourceId);
  if(!source)return 0;
  const hop=(id:string)=>{
    const turn=ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id);
    if(!turn)return null;
    const trigger=turn.trigger_message_id?ctx.db.query('SELECT task_id FROM multiremi_conversation_log WHERE id=?').get(turn.trigger_message_id):null;
    return {id:turn.id,agentId:turn.agent_id,workspaceId:turn.workspace_id,createdAt:turn.created_at,
      delegationId:turn.delegation_id,delegatedByAgentId:turn.delegated_by_agent_id,parentTaskId:trigger?.task_id??null};
  };
  const cutoff=source?ctx.db.query("SELECT MAX(created_at) AS at FROM multiremi_conversation_log WHERE session_id=? AND sender_type='member'").get(source.session_id)?.at:null;
  const node=source?hop(source.id):null;
  return node?countDelegationPairHops(node,targetId,hop,cutoff??null,2*limit):0;
}

export function sendMessageWithinTransaction(ctx:StoreContext,input:SendMessageInput,events:CommitEventQueue,
  createInput:Partial<CreateTaskInput>={}, authorizeRecipient?:(agent:MultiremiAgent)=>void):SendMessageResult {
  if(!ctx.db.inTransaction)throw new Error('sendMessageWithinTransaction requires a transaction');
  let sessionId=input.session_id;
  const originalSession=ctx.issueSessions().getIssueSession(sessionId);
  const originalChat=ctx.chat().getChatSession(sessionId);
  const auto=ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId);
  const workspaceId=originalSession?.workspaceId??originalChat?.workspaceId??auto?.workspace_id
    ??ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id
    ??ctx.db.query('SELECT workspace_id FROM multiremi_turns WHERE session_id=? LIMIT 1').get(sessionId)?.workspace_id
    ??(sessionId.startsWith('auto_orphan_')&&createInput.id?createInput.workspaceId:null);
  if(!workspaceId)throw new Error('Message conversation not found');
  ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
  const issue=originalSession?ctx.issues().getIssue(originalSession.issueId):null;
  let source=input.source_turn_id?ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(input.source_turn_id):null;
  if(input.source_turn_id&&!source)throw new Error('Source turn not found');
  if(source&&(source.workspace_id!==workspaceId||input.sender.type==='agent'&&source.agent_id!==input.sender.id))throw new Error('Source turn does not belong to the sender workspace');
  if(input.sender.type==='agent'){
    const sender=ctx.agents().getAgent(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId)throw new Error('Message sender belongs to another workspace');
  } else if(input.sender.type==='member'&&input.sender.id!==null){
    const sender=ctx.workspaces().getWorkspaceMember(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId||sender.archivedAt)throw new Error('Message sender is not an active workspace member');
  }
  const reply=input.reply_to_id?getMessage(ctx,input.reply_to_id):null;
  if(input.reply_to_id&&(!reply||reply.session_id!==input.session_id))throw new Error('Reply target must be a message in this conversation');
  let recipientType:'agent'|'member'|'none'='none',recipientId:string|null=null;
  let targetIssue=issue;
  let roleScope:string|undefined;
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
      const dispatch=source?.trigger_message_id?getMessage(ctx,source.trigger_message_id):null;
      const origin=dispatch?.task_id?ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(dispatch.task_id):null;
      const delegator=reply?.sender_type==='agent'?reply.sender_id:dispatch?.sender_type==='agent'?dispatch.sender_id:source?.delegated_by_agent_id;
      if(delegator){recipientType='agent';recipientId=delegator;
        sessionId=origin?.agent_id===delegator?origin.session_id:source?.delegated_from_issue_session_id??sessionId;
        roleScope=origin?.agent_id===delegator?origin.execution_scope:undefined;
        const returnSession=ctx.issueSessions().getIssueSession(sessionId);targetIssue=returnSession?ctx.issues().getIssue(returnSession.issueId):null;}

    } else if(input.to.ref==='leader'){
      const squad=ctx.db.query(`SELECT s.leader_id FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id
        WHERE m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL ORDER BY s.id LIMIT 1`).get(input.sender.id,workspaceId);
      recipientType='agent';recipientId=squad?.leader_id??null;
    } else if(input.to.ref==='relay'){recipientType='agent';recipientId=originalChat?.agentId??null;}
  }
  const targetAgent=recipientType==='agent'&&recipientId?ctx.agents().getAgent(recipientId):null;
  const member=recipientType==='member'&&recipientId?ctx.workspaces().getWorkspaceMember(recipientId):null;
  if(targetAgent&&targetAgent.workspaceId!==workspaceId||member&&member.workspaceId!==workspaceId)throw new Error('Message recipient belongs to another workspace');
  if(targetAgent)authorizeRecipient?.(targetAgent);
  // Serializing before dedupe makes a repeated message an idempotent result across PG instances.
  const table=originalSession||sessionId.startsWith('ises_')?'multiremi_issue_sessions':originalChat?'multiremi_chat_sessions':null;
  if(table)ctx.db.run(`UPDATE ${table} SET updated_at=updated_at WHERE id=?`,[sessionId]);
  if(!ctx.conversationLog().getConversationLogHead(sessionId))ctx.conversationLog().ensureConversationLogHead(sessionId,{bodyMd:''});
  ctx.db.run('UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?',[workspaceId,sessionId]);
  const duplicate=input.dedupe_key?ctx.db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND dedupe_key=?').get(sessionId,input.dedupe_key):null;
  if(duplicate){const message=getMessage(ctx,duplicate.id)!;const delivery=message.metadata.delivery_turn_id;
    const turn=ctx.db.query('SELECT id FROM multiremi_turns WHERE id=? OR trigger_message_id=?').get(typeof delivery==='string'?delivery:null,message.id);
    return {message,wake_applied:message.wake_applied,wake_reason:message.wake_reason,...(turn?{turn_id:turn.id}:{})};}
  const sourceSession=source?ctx.issueSessions().getIssueSession(source.session_id):null;
  const limit=pairRoundTripLimit();
  const hops=source&&recipientId?countMessageDelegationPairHops(ctx,source.id,recipientId,limit):0;
  const isLeader=recipientId&&input.sender.id?!!ctx.db.query(`SELECT 1 FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id
    WHERE s.leader_id=? AND m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL`).get(recipientId,input.sender.id,workspaceId):false;
  const parentOwner=issue?.parentIssueId?ctx.issues().getIssue(issue.parentIssueId):null;
  const parentAgent=parentOwner?.assigneeType&&parentOwner.assigneeId?ctx.resolveRunnableAgentForAssignee(parentOwner.assigneeType,parentOwner.assigneeId):null;
  const policy=resolveWake(input.sender,input.to,input.wake_requested,input.message_kind,{
    recipientType,recipientId,recipientAvailable:recipientType==='agent'?!!targetAgent&&!targetAgent.archivedAt:recipientType==='member'?!!member&&!member.archivedAt:false,
    dependenciesMet:!targetIssue||targetIssue.status!=='backlog'||!!createInput.dependencyForce||ctx.issues().listUnmetPrerequisites(targetIssue.id).length===0,
    sourceSideSession:!!sourceSession&&sourceSession.inheritMode!=='none',sourceHasIssue:input.sender.type==='agent'?!!source?.issue_id:undefined,
    targetHasIssue:!!targetIssue,pairHops:hops,pairLimit:limit,
    isReplyToDelegator:reply?.sender_type==='agent'&&reply.sender_id===recipientId||source?.delegated_by_agent_id===recipientId,isLeader:!!isLeader,isParentOwner:parentAgent?.id===recipientId,
  });
  const header:MessageHeader={sender_type:input.sender.type,sender_id:input.sender.id,to_type:input.to.type,
    to_ref:input.to.type==='none'?null:input.to.ref,to_agent_id:recipientType==='agent'?recipientId:null,to_member_id:recipientType==='member'?recipientId:null,
    message_kind:input.message_kind,wake_requested:input.wake_requested,wake_applied:policy.applied,wake_reason:policy.reason,
    reply_to_id:sessionId===input.session_id?input.reply_to_id??null:null,dedupe_key:input.dedupe_key??null,options:input.options??null,
    card_token_hash:null,card_token_recipient:null,card_token_consumed_at:null};
  const body=input.sender.type==='platform'&&['status','report'].includes(input.message_kind)?clampEnvelopeBody(input.body_md):input.body_md;
  const existing=input.id?getMessage(ctx,input.id):null;
  if(existing&&(existing.session_id!==sessionId||existing.sender_type!==input.sender.type||existing.sender_id!==input.sender.id))throw new Error('Cannot readdress a message owned by another sender');
  let entry;
  if(existing){
    if(existing.to_agent_id&&existing.to_agent_id!==recipientId)throw new Error('A routed message cannot change recipient');
    ctx.db.run(`UPDATE multiremi_conversation_log SET to_type=?,to_ref=?,to_agent_id=?,to_member_id=?,message_kind=?,
      wake_requested=?,wake_applied=?,wake_reason=?,dedupe_key=?,options=?,task_id=COALESCE(?,task_id) WHERE id=?`,
      [header.to_type,header.to_ref,header.to_agent_id,header.to_member_id,header.message_kind,header.wake_requested,header.wake_applied,header.wake_reason,
        header.dedupe_key,header.options?JSON.stringify(header.options):null,source?.id??null,existing.id]);
    ctx.conversationLog().updateConversationLogWithinTransaction(sessionId,existing.seq,{fields:{metadata:{...existing.metadata,...input.metadata,pending_completion:false}}});
    ctx.db.run("UPDATE multiremi_conversation_log SET visibility='shown' WHERE id=?",[existing.id]);
    entry=ctx.conversationLog().getConversationLogEntryById(existing.id)!;
  }else{
  entry=ctx.conversationLog().appendWithinTransaction({sessionId,id:input.id??createId(sessionId.startsWith('ises_')?'cmt':'msg'),kind:'message',authorType:input.sender.type,
    authorId:input.sender.id,taskId:source?.id??null,bodyMd:body,parentId:header.reply_to_id,messageHeader:header,visibility:input.visibility,
    metadata:{...input.metadata,...(input.execution_scope?{execution_scope:input.execution_scope}:{})}});
  }
  let message=getMessage(ctx,entry.id)!;
  if(recipientType==='member'&&recipientId){
    const at=entry.created_at;
    ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
      VALUES(?,'member',?,'',?,?) ON CONFLICT DO NOTHING`,[sessionId,recipientId,at,at]);
  }
  let scope=input.execution_scope??roleScope??'';
  let delegatedLane:any=null;
  if(policy.reason==='agent_dispatch'&&source&&targetIssue){
    const latest=ctx.db.query('SELECT * FROM multiremi_turns WHERE issue_id=? AND agent_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(targetIssue.id,recipientId);
    if(latest?.delegated_by_agent_id===input.sender.id&&latest.delegated_from_issue_session_id===source.session_id)delegatedLane=latest;
    scope=input.execution_scope??delegatedLane?.execution_scope??createInput.delegationId??createId('dlg');
  }
  if(message.metadata.execution_scope!==scope){ctx.conversationLog().updateConversationLogWithinTransaction(sessionId,entry.seq,{fields:{metadata:{...message.metadata,execution_scope:scope}}});message=getMessage(ctx,entry.id)!;}
  if(input.attachment_ids?.length){
    for(const id of input.attachment_ids){const attachment=ctx.issues().getAttachment(id);
      if(!attachment||attachment.workspaceId!==workspaceId)throw new Error('Attachment belongs to another workspace');
      if(attachment.commentId&&attachment.commentId!==message.id||attachment.chatMessageId&&attachment.chatMessageId!==message.id)throw new Error('Attachment already belongs to another message');}
    const attachmentSession=ctx.issueSessions().getIssueSession(message.session_id),attachmentChat=ctx.chat().getChatSession(message.session_id);
    if(attachmentSession)ctx.issues().linkAttachmentsToComment(message.id,attachmentSession.issueId,input.attachment_ids);else if(attachmentChat)ctx.issues().linkAttachmentsToChatMessage(attachmentChat.id,message.id,input.attachment_ids);else throw new Error('Automation attachments require an Issue or Chat');
  }
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
  if(input.message_kind==='decision'&&source){
    lockLane(ctx,source.session_id,source.agent_id,source.execution_scope);
    ctx.db.run("UPDATE multiremi_turns SET status='awaiting_human',waiting_on_message_id=? WHERE id=? AND status IN ('pending','running','awaiting_human')",[message.id,source.id]);
  }
  if(input.message_kind==='reply'&&reply?.message_kind==='decision'){
    ctx.db.run('UPDATE multiremi_conversation_log SET resolved_at=COALESCE(resolved_at,?) WHERE id=?',[message.created_at,reply.id]);
    const waiting=ctx.db.query("SELECT * FROM multiremi_turns WHERE waiting_on_message_id=? AND status='awaiting_human'").all(reply.id);
    for(const turn of waiting){lockLane(ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      ctx.db.run("UPDATE multiremi_turns SET status='running',waiting_on_message_id=NULL WHERE id=? AND status='awaiting_human'",[turn.id]);}
  }
  let turnInput=createInput;
  if(input.to.type==='role'&&input.to.ref==='delegator'&&source?.delegation_id){
    turnInput={...createInput,delegationId:source.delegation_id,delegatedByAgentId:recipientId,delegatedFromIssueSessionId:sessionId};
  }
  if(policy.reason==='agent_dispatch'&&source?.issue_id&&sourceSession){
    turnInput={...createInput,delegationId:delegatedLane?.delegation_id??createInput.delegationId??scope,delegatedByAgentId:input.sender.id,
      delegatedFromIssueSessionId:sourceSession.id,parentTaskId:null};
  }
  const turnId=ensurePendingTurn(ctx,message,{...input,execution_scope:scope,session_id:sessionId},events,turnInput);
  if(turnId){ctx.conversationLog().updateConversationLogWithinTransaction(sessionId,message.seq,{fields:{metadata:{...message.metadata,delivery_turn_id:turnId}}});message=getMessage(ctx,message.id)!;}
  if(policy.applied!==input.wake_requested&&targetIssue)ctx.appendIssueActivity(targetIssue.id,{actorType:'system',actorId:null,type:'wake_downgraded',
    body:policy.reason,data:{message_id:message.id,requested:input.wake_requested,applied:policy.applied,reason:policy.reason}},events);
  const affected=new Set(turnId||input.message_kind==='decision'||reply?.message_kind==='decision'?[targetIssue?.id,source?.issue_id]:[]);
  for(const id of affected)if(id)deriveIssueStatusWithinTransaction(ctx,id,events);
  // Cross-conversation inbox caches need a workspace signal even without a log subscription.
  ctx.emitWorkspaceEvent({type:'inbox:new',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
  return {message,wake_applied:policy.applied,wake_reason:policy.reason,...(turnId?{turn_id:turnId}:{})};
}
