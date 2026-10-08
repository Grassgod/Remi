import type { IssueDelivery, IssueResponsibleActor, SubmitIssueDeliveryInput, RespondIssueDeliveryInput, ListIssueDeliveriesInput } from '@multiremi/contracts';
import type { StoreContext } from './context.js';
import { createCommitEventQueue } from './context.js';
import { getMessage, sendMessageWithinTransaction } from './inbox/send-message.js';
import { lockIssueRowsWithinTransaction } from './issue-row-lock.js';
import { createId } from '@multiremi/ids.js';
import type { ChildStatusChangeCollector } from './repos/tasks-repo.js';
import { parseJson } from './helpers.js';
import { afterCommit } from './db/postgres.js';

export class IssueDeliveryError extends Error {
  constructor(public code: string, message: string, public status: 403 | 404 | 409 = 409) { super(message); }
}
export interface IssueDeliveryActor { type: 'agent' | 'member'; id: string; taskId?: string | null }

/** Freeze the whole parent chain before checking responsibility/revision. */
function lockResponsibilityChain(ctx: StoreContext, issueId: string): void {
  const ids: string[] = [];
  let id: string | null = issueId;
  while (id && !ids.includes(id)) {
    ids.push(id);
    const row = ctx.db.query('SELECT parent_issue_id FROM multiremi_issues WHERE id=?').get(id);
    id = row?.parent_issue_id ? String(row.parent_issue_id) : null;
  }
  const locked = lockIssueRowsWithinTransaction(ctx.db, ids);
  const actual = ctx.resolveIssueResponsibility(issueId);
  if (actual.chain.some(item => !locked.get(item.issueId))) throw new IssueDeliveryError('issue_delivery_revision_stale','Responsibility changed while acquiring its lock; retry');
}

function deliveryIssueSql(ctx: StoreContext): string {
  return ctx.db.dialect === 'postgres' ? "m.metadata::jsonb->'issue_delivery'->>'issueId'" : "json_extract(m.metadata,'$.issue_delivery.issueId')";
}

function deliveryFromRow(row: Record<string, unknown>): IssueDelivery {
  const metadata = parseJson<Record<string,unknown>>(row.metadata,{});
  return {...metadata.issue_delivery as IssueDelivery,id:String(row.id),createdAt:String(row.created_at)};
}

function getIssueDelivery(ctx: StoreContext, issueId: string, deliveryId: string): IssueDelivery | null {
  const row = ctx.db.query(`SELECT m.id,m.created_at,m.metadata FROM multiremi_conversation_log m
    JOIN multiremi_issue_sessions s ON s.id=m.session_id WHERE m.id=? AND s.issue_id=? AND m.kind='message'
    AND m.message_kind='report' AND m.deleted_at IS NULL AND ${deliveryIssueSql(ctx)}=?`).get(deliveryId,issueId,issueId);
  return row ? deliveryFromRow(row) : null;
}

export function listIssueDeliveries(ctx: StoreContext, issueId: string, input: ListIssueDeliveriesInput = {}): IssueDelivery[] {
  const limit = Math.max(1,Math.min(101,Math.trunc(input.limit ?? 50)));
  const cursor = input.before ? ctx.db.query(`SELECT m.created_at,m.seq,m.id FROM multiremi_conversation_log m
    JOIN multiremi_issue_sessions s ON s.id=m.session_id WHERE m.id=? AND s.issue_id=? AND ${deliveryIssueSql(ctx)}=?`).get(input.before,issueId,issueId) : null;
  if (input.before && !cursor) throw new IssueDeliveryError('issue_delivery_cursor_invalid','Choose a delivery from this Issue as the cursor');
  const rows = ctx.db.query(`SELECT m.id,m.created_at,m.metadata FROM multiremi_conversation_log m JOIN multiremi_issue_sessions s ON s.id=m.session_id
    WHERE s.issue_id=? AND m.kind='message' AND m.message_kind='report' AND m.deleted_at IS NULL AND ${deliveryIssueSql(ctx)}=?
    ${cursor ? 'AND (m.created_at,m.seq,m.id) < (?,?,?)' : ''} ORDER BY m.created_at DESC,m.seq DESC,m.id DESC LIMIT ?`)
    .all(issueId,issueId,...(cursor ? [cursor.created_at,cursor.seq,cursor.id] : []),limit);
  return rows.map(deliveryFromRow);
}

export function assertIssueDeliveryAccepted(ctx: StoreContext, issueId: string, deliveryId?: string): void {
  const responsibility = ctx.resolveIssueResponsibility(issueId);
  if (!responsibility.reviewOwner || !responsibility.rootHuman || responsibility.unresolved.length) throw new IssueDeliveryError('issue_responsibility_unresolved', 'Configure the Issue responsibility chain before closure');
  const latest = listIssueDeliveries(ctx, issueId,{limit:1})[0];
  if (!latest || latest.id !== deliveryId || latest.status !== 'accepted' || latest.responsibilityRevision !== responsibility.revision) {
    throw new IssueDeliveryError('issue_delivery_acceptance_required', 'The current delivery must be accepted by its designated reviewer before closure');
  }
}

function authorizeActor(ctx: StoreContext, actor: IssueDeliveryActor, expected: IssueResponsibleActor, workspaceId: string): void {
  const member = actor.type === 'member' ? ctx.workspaces().getWorkspaceMember(actor.id)
    ?? ctx.workspaces().findWorkspaceMemberForUser(actor.id, workspaceId) : null;
  const actorId = member?.id ?? actor.id;
  if (actor.type !== expected.type || actorId !== expected.id) throw new IssueDeliveryError('issue_delivery_actor_forbidden', 'Only the designated Issue responsibility holder may perform this action', 403);
  if (actor.type === 'agent') {
    const task = actor.taskId ? ctx.tasks().getTask(actor.taskId) : null;
    if (!task || task.agentId !== actor.id || task.workspaceId !== workspaceId || task.issueId !== expected.issueId) {
      throw new IssueDeliveryError('issue_delivery_actor_forbidden', 'The agent must act from its own responsibility Issue session', 403);
    }
    const session = task.issueSessionId ? ctx.issueSessions().getIssueSession(task.issueSessionId) : null;
    if (!session || session.inheritMode !== 'none' || task.chatSessionId) throw new IssueDeliveryError('issue_delivery_side_session_forbidden','Use the main responsibility Issue session for formal delivery or acceptance',403);
  }
}

export function submitIssueDelivery(ctx: StoreContext, issueId: string, input: SubmitIssueDeliveryInput, actor: IssueDeliveryActor): IssueDelivery {
  const events = createCommitEventQueue();
  const changes: ChildStatusChangeCollector = [];
  let outcome: ReturnType<ReturnType<StoreContext['issues']>['updateIssueWithinTransaction']> | undefined;
  const result = ctx.db.transaction(() => {
    let issue = ctx.issues().getIssue(issueId);
    if (!issue) throw new IssueDeliveryError('issue_not_found', 'Issue not found', 404);
    ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
    lockResponsibilityChain(ctx,issueId);
    issue = ctx.issues().getIssue(issueId)!;
    const responsibility = ctx.resolveIssueResponsibility(issueId);
    if (!responsibility.executionOwner || !responsibility.reviewOwner || !responsibility.rootHuman || responsibility.unresolved.length) throw new IssueDeliveryError('issue_responsibility_unresolved', 'Configure the Issue responsibility chain before delivery');
    authorizeActor(ctx, actor, responsibility.executionOwner, issue.workspaceId);
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) throw new IssueDeliveryError('issue_delivery_summary_required', 'A delivery summary is required');
    if (['done','cancelled'].includes(issue.status) || issue.archivedAt) throw new IssueDeliveryError('issue_delivery_closed', 'Reopen the Issue before submitting a new delivery');
    const sourceTask=ctx.tasks().getTask(actor.taskId!)!;
    const session = ctx.issueSessions().getIssueSession(input.sessionId ?? sourceTask.issueSessionId!);
    if (!session || session.issueId !== issueId || session.workspaceId !== issue.workspaceId || session.inheritMode !== 'none') throw new IssueDeliveryError('issue_delivery_session_invalid', 'Delivery session must be a main session of the Issue');
    if(session.id!==sourceTask.issueSessionId)throw new IssueDeliveryError('issue_delivery_session_invalid','Submit from the execution task original Issue session');
    const id = createId('cmt');
    const sourceTurn = actor.taskId ? ctx.db.query('SELECT id,execution_scope FROM multiremi_turns WHERE current_attempt_id=? OR id=?').get(actor.taskId,actor.taskId) : null;
    const delivery: IssueDelivery = {id,issueId,sourceSessionId:session.id,summary,status:'pending',submittedBy:responsibility.executionOwner,
      reviewOwner:responsibility.reviewOwner,responsibilityRevision:responsibility.revision,responseMessageId:null,responseBody:null,createdAt:'',respondedAt:null};
    const message = sendMessageWithinTransaction(ctx, {id,session_id:session.id,sender:{type:actor.type,id:responsibility.executionOwner.id},
      to:{type:responsibility.reviewOwner.type,ref:responsibility.reviewOwner.id},message_kind:'report',wake_requested:'inbox_only',body_md:summary,
      source_turn_id:sourceTurn ? String(sourceTurn.id) : undefined,execution_scope:sourceTurn ? String(sourceTurn.execution_scope) : undefined,
      dedupe_key:input.dedupeKey ? `issue_delivery:${input.dedupeKey}` : undefined,metadata:{issue_delivery:delivery}},events).message;
    if (!message.metadata.issue_delivery) throw new IssueDeliveryError('issue_delivery_dedupe_conflict', 'Delivery key belongs to another message');
    const stored = {...message.metadata.issue_delivery as IssueDelivery,id:message.id,createdAt:message.created_at};
    if (message.id === id) {
      outcome = ctx.issues().updateIssueWithinTransaction(issueId,{status:'in_review',actorType:actor.type,actorId:actor.id}, {}, changes, events);
      events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:actor.type,actorId:actor.id,
        payload:{issue:outcome.issue,status_changed:outcome.previous.status !== outcome.issue.status,prev_status:outcome.previous.status}});
      ctx.appendIssueActivity(issueId,{actorType:actor.type,actorId:actor.id,type:'issue_delivery_submitted',body:summary,data:{deliveryId:message.id,reviewOwner:responsibility.reviewOwner}},events);
      if (issue.parentIssueId && responsibility.reviewOwner.type === 'agent') {
        const parentSession = ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(issue.parentIssueId);
        sendMessageWithinTransaction(ctx,{session_id:parentSession.id,sender:{type:'platform',id:null},to:{type:'agent',ref:responsibility.reviewOwner.id},
          message_kind:'report',wake_requested:'now',body_md:`${issue.key} delivered for acceptance. Read delivery ${message.id}.`,
          dedupe_key:`issue_delivery_notice:${message.id}`,metadata:{issue_delivery_id:message.id,source_issue_id:issue.id}},events);
      }
    }
    return stored;
  })();
  const committedOutcome=outcome;
  afterCommit(ctx.db,()=>{
    if (committedOutcome) ctx.issues().runIssueUpdatePostCommit(committedOutcome,{status:'in_review'},changes,events);
    else ctx.emitCommitEvents(events);
  });
  return result;
}

export function respondIssueDelivery(ctx: StoreContext, issueId: string, deliveryId: string, input: RespondIssueDeliveryInput, actor: IssueDeliveryActor): IssueDelivery {
  const events = createCommitEventQueue();
  const changes: ChildStatusChangeCollector = [];
  let outcome: ReturnType<ReturnType<StoreContext['issues']>['updateIssueWithinTransaction']> | undefined;
  const result = ctx.db.transaction(() => {
    let issue = ctx.issues().getIssue(issueId);
    if (!issue) throw new IssueDeliveryError('issue_not_found','Issue not found',404);
    ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
    lockResponsibilityChain(ctx,issueId);
    issue = ctx.issues().getIssue(issueId)!;
    const responsibility = ctx.resolveIssueResponsibility(issueId);
    const delivery = getIssueDelivery(ctx,issueId,deliveryId);
    if (!delivery) throw new IssueDeliveryError('issue_delivery_not_found','Delivery not found',404);
    if (!responsibility.reviewOwner || !responsibility.rootHuman || responsibility.unresolved.length) throw new IssueDeliveryError('issue_responsibility_unresolved','Configure the Issue responsibility chain before acceptance');
    const grant = delivery.authorization;
    const authorizedAgent = actor.type === 'agent' && responsibility.reviewOwner.type === 'member'
      && grant?.agentId === actor.id && grant.grantedBy === responsibility.reviewOwner.id
      && grant.responsibilityRevision === responsibility.revision;
    authorizeActor(ctx,actor,authorizedAgent ? {type:'agent',id:actor.id,issueId:issue.id,name:actor.id} : responsibility.reviewOwner,issue.workspaceId);
    if (input.revision !== responsibility.revision || delivery.responsibilityRevision !== responsibility.revision) throw new IssueDeliveryError('issue_delivery_revision_stale','Responsibility changed; submit a new delivery to the current reviewer');
    if (!['accept','return'].includes(input.action)) throw new IssueDeliveryError('issue_delivery_action_invalid','Choose accept or return');
    if (delivery.status !== 'pending') {
      if (delivery.status === (input.action === 'accept' ? 'accepted' : 'returned')) return delivery;
      throw new IssueDeliveryError('issue_delivery_already_responded','This delivery already has a response');
    }
    if (['done','cancelled'].includes(issue.status) || issue.archivedAt) throw new IssueDeliveryError('issue_delivery_closed','Reopen the Issue before responding to a pending delivery');
    if (listIssueDeliveries(ctx,issueId,{limit:1})[0]?.id !== deliveryId) throw new IssueDeliveryError('issue_delivery_superseded','Only the latest delivery can be accepted or returned');
    if (input.action === 'accept' && ctx.issues().countOpenChildIssues(issueId)) throw new IssueDeliveryError('issue_delivery_children_open','Finish or cancel child issues before acceptance');
    if (input.body !== undefined && typeof input.body !== 'string') throw new IssueDeliveryError('issue_delivery_response_invalid','Delivery response body must be text');
    if (input.action === 'return' && !input.body?.trim()) throw new IssueDeliveryError('issue_delivery_return_reason_required','Explain what needs to change');
    const responseActorId = authorizedAgent ? actor.id : responsibility.reviewOwner.id;
    const response = sendMessageWithinTransaction(ctx,{session_id:delivery.sourceSessionId,sender:{type:actor.type,id:responseActorId},
      to:{type:'agent',ref:delivery.submittedBy.id},message_kind:'reply',wake_requested:'inbox_only',reply_to_id:delivery.id,
      body_md:input.body?.trim() || 'Delivery accepted',dedupe_key:`issue_delivery_response:${delivery.id}`,
      metadata:{issue_delivery_response:{deliveryId,action:input.action,responsibilityRevision:responsibility.revision,
        ...(authorizedAgent ? {authorizedBy:grant!.grantedBy,authorization:grant} : {})}}},events).message;
    const updated: IssueDelivery = {...delivery,status:input.action === 'accept' ? 'accepted' : 'returned',responseMessageId:response.id,responseBody:response.body_md,respondedAt:response.created_at};
    const original = getMessage(ctx,delivery.id)!;
    ctx.conversationLog().updateConversationLogWithinTransaction(original.session_id,original.seq,{deferEmit:true,fields:{metadata:{...original.metadata,issue_delivery:updated}}});
    outcome = ctx.issues().updateIssueWithinTransaction(issueId,{status:input.action === 'accept' ? 'done' : 'in_progress',actorType:actor.type,actorId:responseActorId},
      {allowParentStatusGuardBypass:true,...(input.action === 'accept' ? {acceptedDeliveryId:deliveryId} : {})},changes,events);
    ctx.appendIssueActivity(issueId,{actorType:actor.type,actorId:responseActorId,type:input.action === 'accept' ? 'issue_delivery_accepted' : 'issue_delivery_returned',
      body:input.body ?? null,data:{deliveryId,responseMessageId:response.id,reviewOwner:responsibility.reviewOwner,...(authorizedAgent ? {authorization:grant} : {})}},events);
    if (input.action === 'return') sendMessageWithinTransaction(ctx,{session_id:delivery.sourceSessionId,sender:{type:'platform',id:null},
      to:{type:'agent',ref:delivery.submittedBy.id},message_kind:'status',wake_requested:'now',
      body_md:`Delivery ${delivery.id} returned: ${input.body}`,execution_scope:typeof original.metadata.execution_scope === 'string' ? original.metadata.execution_scope : '',
      dedupe_key:`issue_delivery_return:${delivery.id}`,metadata:{issue_delivery_id:delivery.id,response_message_id:response.id}},events);
    events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:actor.type,actorId:responseActorId,
      payload:{issue:ctx.issues().getIssue(issueId),status_changed:outcome.previous.status !== outcome.issue.status,prev_status:outcome.previous.status}});
    return updated;
  })();
  const committedOutcome=outcome;
  afterCommit(ctx.db,()=>{
    if (committedOutcome) ctx.issues().runIssueUpdatePostCommit(committedOutcome,{status:input.action === 'accept' ? 'done' : 'in_progress'},changes,events);
    else ctx.emitCommitEvents(events);
  });
  return result;
}

/** A human's explicit proxy grant applies to this delivery/version only. General parent grants never count. */
export function authorizeIssueDelivery(ctx: StoreContext, issueId: string, deliveryId: string, agentId: string | null, revision: string, actor: IssueDeliveryActor): IssueDelivery {
  const events = createCommitEventQueue();
  const result = ctx.db.transaction(() => {
    let issue = ctx.issues().getIssue(issueId);
    if (!issue) throw new IssueDeliveryError('issue_not_found','Issue not found',404);
    ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId); lockResponsibilityChain(ctx,issueId);
    issue = ctx.issues().getIssue(issueId)!;
    if (['done','cancelled'].includes(issue.status) || issue.archivedAt) throw new IssueDeliveryError('issue_delivery_closed','Reopen the Issue before authorizing a pending delivery');
    const responsibility = ctx.resolveIssueResponsibility(issueId);
    const delivery = listIssueDeliveries(ctx,issueId,{limit:1})[0];
    if (!delivery || delivery.id !== deliveryId || delivery.status !== 'pending') throw new IssueDeliveryError('issue_delivery_not_pending','Authorize the latest pending delivery');
    if (!responsibility.reviewOwner || responsibility.reviewOwner.type !== 'member' || !responsibility.rootHuman || responsibility.unresolved.length) throw new IssueDeliveryError('issue_delivery_authorization_requires_human','Only the root designated human with a complete responsibility chain may grant proxy acceptance',403);
    authorizeActor(ctx,actor,responsibility.reviewOwner,issue.workspaceId);
    if (revision !== responsibility.revision || delivery.responsibilityRevision !== revision) throw new IssueDeliveryError('issue_delivery_revision_stale','Responsibility changed');
    if (agentId !== null && agentId !== responsibility.executionOwner?.id) throw new IssueDeliveryError('issue_delivery_authorization_target_invalid','Authorize only the Issue execution owner for this specific delivery');
    const at = new Date().toISOString();
    const updated = {...delivery,authorization:agentId === null ? null : {agentId,grantedBy:responsibility.reviewOwner.id,responsibilityRevision:revision,grantedAt:at}};
    const original = getMessage(ctx,deliveryId)!;
    ctx.conversationLog().updateConversationLogWithinTransaction(original.session_id,original.seq,{deferEmit:true,fields:{metadata:{...original.metadata,issue_delivery:updated}}});
    ctx.appendIssueActivity(issueId,{actorType:'member',actorId:responsibility.reviewOwner.id,type:'issue_delivery_authorized',
      body:null,data:{deliveryId,authorization:updated.authorization}},events);
    events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:'member',actorId:responsibility.reviewOwner.id,
      payload:{issue,status_changed:false}});
    return updated;
  })();
  afterCommit(ctx.db,()=>ctx.emitCommitEvents(events)); return result;
}
