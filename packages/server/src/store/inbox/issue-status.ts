import type { CommitEventQueue, StoreContext } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
import { questionMetadataText } from './question-indexes.js';

/** Only turns and unanswered owner decisions participate; attempts are deliberately absent. */
export function deriveIssueStatusWithinTransaction(ctx:StoreContext,issueId:string,events:CommitEventQueue): {changed:boolean;previousStatus:string|null} {
  if(!ctx.db.inTransaction)throw new Error('Issue derivation requires a transaction');
  if(!ctx.db.run('UPDATE multiremi_issues SET id=id WHERE id=?',[issueId]).changes)return {changed:false,previousStatus:null};
  const issue=ctx.issues().getIssue(issueId);
  if(!issue||['done','cancelled'].includes(issue.status))return {changed:false,previousStatus:issue?.status??null};
  const owner=ctx.resolveIssueResponsibility(issueId).executionOwner;
  const turns=ctx.db.query(`SELECT t.*,m.sender_type AS trigger_sender,m.wake_reason AS trigger_reason,m.message_kind AS trigger_kind,
      (SELECT COUNT(*) FROM multiremi_conversation_log merged WHERE merged.kind='message' AND merged.deleted_at IS NULL
        AND ${questionMetadataText(ctx.db, 'merged.metadata', 'delivery_turn_id')}=t.id
        AND merged.wake_reason IN ('human_sender','agent_dispatch')) AS merged_work_triggers
    FROM multiremi_turns t LEFT JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id
    WHERE t.issue_id=? AND t.session_id NOT LIKE 'chat_%' ORDER BY t.created_at DESC,t.seq DESC,t.id DESC`).all(issueId);
  const active=turns.filter(t=>['running','awaiting_human','pending'].includes(t.status));
  const decision=owner?ctx.db.query(`SELECT 1 FROM multiremi_conversation_log d JOIN multiremi_issue_sessions s ON s.id=d.session_id
    WHERE s.issue_id=? AND d.kind='message' AND d.message_kind='decision' AND d.sender_type='agent' AND d.sender_id=?
      AND d.deleted_at IS NULL AND d.resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM multiremi_conversation_log r
      WHERE r.reply_to_id=d.id AND r.message_kind='reply' AND r.deleted_at IS NULL) LIMIT 1`).get(issueId,owner.id):null;
  let status:string|null=null;
  let last=turns[0];
  // in_review means a human must act or read: a question at the human stage, or a finished round.
  const humanQuestion=!active.some(t=>t.status==='running')&&ctx.issues().countPendingIssueDecisions(issueId)>0;
  if(active.some(t=>t.status==='running'))status='in_progress';
  else if(humanQuestion)status='in_review';
  // A question still waiting on a Leader is execution, not review.
  else if(active.some(t=>t.status==='awaiting_human')||decision)status='in_progress';
  else if(active.some(t=>t.status==='pending')){
    if(active.some(t=>Number(t.merged_work_triggers)>0||t.trigger_sender==='member'||t.trigger_reason==='agent_dispatch'||['human_sender','agent_dispatch'].includes(t.wake_source)))status='todo';
  }else{
    // Intake completion belongs to the business round, including unassigned intake work.
    const latest=issue.issueKind==='intake'
      ? turns.toSorted((a,b)=>String(b.ended_at??b.created_at).localeCompare(String(a.ended_at??a.created_at)))[0]
      : turns.find(t=>t.agent_id===owner?.id);
    if(issue.issueKind==='intake')last=latest??last;
    status=latest?.status==='completed'?'in_review':latest?.status==='failed'?'blocked':latest?.status==='cancelled'?'todo':null;
    // A finished round derives only in_review; closing it follows the done rule.
  }
  if(!status)return {changed:false,previousStatus:issue.status};
  // A parent legitimately parks at in_review while a human answers, even with open children.
  status=ctx.issues().holdParentStatusForOpenChildren(issueId,status,{exempt:humanQuestion,deferredEvents:events});
  if(status===issue.status)return {changed:false,previousStatus:issue.status};
  const at=nowIso();
  const completedAt=status==='done'?at:null;
  ctx.db.run('UPDATE multiremi_issues SET status=?,completed_at=?,archived_at=NULL,updated_at=? WHERE id=?',[status,completedAt,at,issueId]);
  const updated=ctx.issues().getIssue(issueId)!;
  const actorId=issue.issueKind==='intake'?last?.agent_id??null:owner?.id??last?.agent_id??null;
  const {event,dependencyCheckEventId}=ctx.autopilots().enqueueIssueStatusChangedEvent({issue:updated,previousStatus:issue.status,
    actorType:'agent',actorId,automationSourceTaskId:last?.current_attempt_id??null});
  const changes:import('../repos/tasks-repo.js').ChildStatusChangeCollector=[];
  ctx.issues().notifyChildStatusChangeWithinTransaction(issue,updated,last?.current_attempt_id??'',changes,events,{statusChangeEventId:event?.id,taskTerminalStatus:['completed','failed','cancelled'].includes(last?.status)?last.status:undefined});
  if(last)changes.push({previous:issue,issue:updated,taskId:last.current_attempt_id,dependencyCheckEventId,taskTerminalStatus:['completed','failed','cancelled'].includes(last.status)?last.status:undefined});
  if(changes.length)afterCommit(ctx.db,()=>ctx.tasks().runCollectedChildStatusChanges(changes));
  events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:'agent',actorId,
    payload:{issue:{id:issueId,status,completed_at:completedAt,archived_at:null,updated_at:at},status_changed:true,prev_status:issue.status}});
  return {changed:true,previousStatus:issue.status};
}
