import type { IssueResponsibilityMigrationList, IssueResponsibilityMigrationItem, MapIssueResponsibilityInput } from '@multiremi/contracts';
import type { StoreContext } from './context.js';
import { createCommitEventQueue } from './context.js';
import { IssueDeliveryError, type IssueDeliveryActor } from './issue-deliveries.js';
import { lockIssueRowsWithinTransaction } from './issue-row-lock.js';
import { afterCommit } from './db/postgres.js';

/** Review candidates, never infer or write historical responsibility on a read. */
export function listIssueResponsibilityMigration(ctx:StoreContext,workspaceId:string,input:{limit?:number;offset?:number}={}):IssueResponsibilityMigrationList {
  const limit=Math.max(1,Math.min(100,Math.trunc(input.limit??50)));
  const offset=Math.max(0,Math.trunc(input.offset??0));
  const predicate=`i.workspace_id=? AND i.parent_issue_id IS NULL AND
    (h.id IS NULL OR h.archived_at IS NOT NULL OR h.workspace_id<>i.workspace_id)`;
  const total=Number(ctx.db.query(`SELECT COUNT(*) AS total FROM multiremi_issues i LEFT JOIN multiremi_workspace_members h ON h.id=i.responsible_member_id WHERE ${predicate}`).get(workspaceId)?.total??0);
  const rootCount=Number(ctx.db.query('SELECT COUNT(*) AS total FROM multiremi_issues WHERE workspace_id=? AND parent_issue_id IS NULL').get(workspaceId)?.total??0);
  const legacyMemberExecutionCount=Number(ctx.db.query("SELECT COUNT(*) AS total FROM multiremi_issues WHERE workspace_id=? AND assignee_type='member'").get(workspaceId)?.total??0);
  const rows=ctx.db.query(`SELECT i.id FROM multiremi_issues i LEFT JOIN multiremi_workspace_members h ON h.id=i.responsible_member_id
    WHERE ${predicate} ORDER BY i.created_at,i.id LIMIT ? OFFSET ?`).all(workspaceId,limit,offset);
  const items:IssueResponsibilityMigrationItem[]=rows.map(row=>{
    const issue=ctx.issues().getIssue(String(row.id))!;
    const responsibility=ctx.resolveIssueResponsibility(issue.id);
    const candidates:IssueResponsibilityMigrationItem['candidates']=[];
    const candidate=(ref:string|null|undefined,source:IssueResponsibilityMigrationItem['candidates'][number]['source'])=>{
      if(!ref)return;
      const member=ctx.workspaces().getWorkspaceMember(ref)??ctx.workspaces().findWorkspaceMemberForUser(ref,workspaceId);
      if(member)candidates.push({memberId:member.id,name:member.name,source,available:!member.archivedAt&&member.workspaceId===workspaceId});
    };
    if(issue.assigneeType==='member')candidate(issue.assigneeId,'legacy_member_assignee');
    candidate(issue.createdBy,'historical_creator');
    return {issueId:issue.id,key:issue.key,title:issue.title,responsibleMemberId:issue.responsibleMemberId??null,
      assigneeType:issue.assigneeType,assigneeId:issue.assigneeId,createdById:issue.createdBy,
      revision:responsibility.revision,unresolved:responsibility.unresolved,candidates};
  });
  return {workspaceId,total,rootCount,legacyMemberExecutionCount,items,nextOffset:offset+items.length<total?offset+items.length:null};
}

/** Explicit, revision-bound human mapping; audit and pending-Q transfer commit together. */
export function mapIssueResponsibility(ctx:StoreContext,workspaceId:string,input:MapIssueResponsibilityInput,actor:IssueDeliveryActor):{mappedIssueIds:string[]} {
  const member=actor.type==='member'?ctx.workspaces().getWorkspaceMember(actor.id):null;
  if(!member||member.archivedAt||member.workspaceId!==workspaceId||!['owner','admin'].includes(member.role))
    throw new IssueDeliveryError('issue_responsibility_mapping_forbidden','An active human workspace administrator must confirm the mapping',403);
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new IssueDeliveryError('issue_responsibility_mapping_reason_required','Explain how these human responsibilities were verified');
  if(!Array.isArray(input.mappings)||!input.mappings.length||input.mappings.length>100)throw new IssueDeliveryError('issue_responsibility_mapping_invalid','Map from 1 to 100 explicit root Issue/member/revision entries');
  const ids=input.mappings.map(entry=>entry?.issueId);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new IssueDeliveryError('issue_responsibility_mapping_invalid','Every root Issue must appear exactly once');
  const events=createCommitEventQueue();
  const result=ctx.db.transaction(()=>{
    ctx.lockWorkspaceRuntimeLifecycle(workspaceId);lockIssueRowsWithinTransaction(ctx.db,ids);
    for(const entry of input.mappings) {
      const issue=ctx.issues().getIssue(entry.issueId);
      if(!issue||issue.workspaceId!==workspaceId||issue.parentIssueId)throw new IssueDeliveryError('issue_responsibility_mapping_invalid','Map only root Issues in the selected workspace');
      if(ctx.resolveIssueResponsibility(issue.id).revision!==entry.revision)throw new IssueDeliveryError('issue_responsibility_mapping_stale','Responsibility facts changed; review the migration list again');
      const human=typeof entry.memberId==='string'?ctx.workspaces().getWorkspaceMember(entry.memberId):null;
      if(!human||human.archivedAt||human.workspaceId!==workspaceId)throw new IssueDeliveryError('issue_responsibility_mapping_invalid','Choose an active human member in the Issue workspace');
    }
    for(const entry of input.mappings) {
      ctx.issues().updateIssueWithinTransaction(entry.issueId,{responsibleMemberId:entry.memberId,actorType:'member',actorId:member.id},{},[],events);
      ctx.appendIssueActivity(entry.issueId,{type:'issue_responsibility_transferred',actorType:'member',actorId:member.id,body:input.reason.trim(),
        data:{migration:true,memberId:entry.memberId,previousRevision:entry.revision,revision:ctx.resolveIssueResponsibility(entry.issueId).revision}},events);
      events.workspace.push({type:'issue:updated',workspaceId,actorType:'member',actorId:member.id,payload:{issue:ctx.issues().getIssue(entry.issueId),status_changed:false}});
    }
    return {mappedIssueIds:ids};
  })();
  afterCommit(ctx.db,()=>ctx.emitCommitEvents(events));return result;
}
