import type { StoreContext, CommitEventQueue } from './context.js';
import { refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction, refreshChatQuestionsAfterResponsibilityChangeWithinTransaction } from './inbox/questions.js';
import { createCommitEventQueue } from './context.js';
import { afterCommit } from './db/postgres.js';

/** Call after a responsibility fact changes, inside its owning W-locked transaction. */
export function refreshResponsibilityQuestions(ctx: StoreContext, issueId: string, events: CommitEventQueue,
  actorType?: string, actorId?: string | null, reason = 'issue_responsibility_transferred'): void {
  const actor: import('@multiremi/contracts').QuestionActor | undefined = actorId && (actorType === 'agent' || actorType === 'member') ? {type:actorType,id:actorId} : undefined;
  refreshIssueQuestionsAfterResponsibilityChangeWithinTransaction(ctx,issueId,events,actor,reason);
}

export function refreshResponsibilityEntity(ctx: StoreContext, kind: 'agent' | 'squad' | 'member', id: string, events: CommitEventQueue, reason: string, previousWorkspaceIds:string[]=[]): void {
  if (!ctx.db.inTransaction) throw new Error('Responsibility refresh requires its mutation transaction');
  for (const row of affectedIssues(ctx,kind,id)) refreshResponsibilityQuestions(ctx,String(row.id),events,undefined,undefined,reason);
  if(kind!=='squad') {
    const entity=kind==='agent'?ctx.agents().getAgent(id):ctx.workspaces().getWorkspaceMember(id);
    for(const workspaceId of [...new Set([...previousWorkspaceIds,...(entity?[entity.workspaceId]:[])])].sort()) {
      refreshChatQuestionsAfterResponsibilityChangeWithinTransaction(ctx,workspaceId,events,undefined,undefined,
        kind==='agent'?{agentId:id}:{memberId:id});
    }
  }
}

function affectedIssues(ctx: StoreContext, kind: 'agent' | 'squad' | 'member', id: string) {
  return kind === 'member'
    ? ctx.db.query('SELECT id FROM multiremi_issues WHERE responsible_member_id=? ORDER BY id').all(id)
    : kind === 'squad' ? ctx.db.query("SELECT id FROM multiremi_issues WHERE assignee_type='squad' AND assignee_id=? ORDER BY id").all(id)
    : ctx.db.query(`SELECT id FROM multiremi_issues WHERE (assignee_type='agent' AND assignee_id=?)
      OR (assignee_type='squad' AND assignee_id IN (SELECT id FROM multiremi_squads WHERE leader_id=?)) ORDER BY id`).all(id,id);
}

export function refreshResponsibilityEntityChange(ctx: StoreContext, kind: 'agent' | 'squad' | 'member', id: string, reason: string, previousWorkspaceIds:string[]=[]): void {
  const events = createCommitEventQueue();
  refreshResponsibilityEntity(ctx,kind,id,events,reason,previousWorkspaceIds);
  const issues = affectedIssues(ctx,kind,id);
  for (const row of issues) {
    const issue = ctx.issues().getIssue(String(row.id));
    if (!issue) continue;
    ctx.appendIssueActivity(issue.id,{actorType:'system',actorId:null,type:'issue_responsibility_transferred',
      body:null,data:{entityType:kind,entityId:id,reason,revision:ctx.resolveIssueResponsibility(issue.id).revision}},events);
    events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:'system',actorId:null,payload:{issue,status_changed:false}});
  }
  afterCommit(ctx.db,() => ctx.emitCommitEvents(events));
}
