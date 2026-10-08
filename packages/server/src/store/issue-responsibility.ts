import { createHash } from 'node:crypto';
import type { IssueResponsibility, IssueResponsibleActor } from '@multiremi/contracts';
import type { MultiremiIssue } from '@multiremi/contracts/types.js';
import type { StoreContext } from './context.js';

/** The only responsibility resolver: no sender-team, runnable-member or workspace-owner fallback. */
export function resolveIssueResponsibility(ctx: StoreContext, issueId: string): IssueResponsibility {
  const result: IssueResponsibility = { issueId, workspaceId: null, executionOwner: null, reviewOwner: null,
    rootHuman: null, rootIssueId: null, chain: [], unresolved: [], revision: '' };
  const facts: unknown[] = [];
  const seen = new Set<string>();
  let issue = ctx.issues().getIssue(issueId);
  const fail = (id: string, reason: IssueResponsibility['unresolved'][number]['reason']) => result.unresolved.push({issueId: id, reason});
  const owner = (item: MultiremiIssue): IssueResponsibleActor | null => {
    let id: string | null = null;
    if (item.assigneeType === 'agent') id = item.assigneeId;
    else if (item.assigneeType === 'squad' && item.assigneeId) {
      const team = ctx.squads().getSquad(item.assigneeId);
      facts.push(['team', item.assigneeId, team?.leaderId, team?.archivedAt]);
      if (!team || team.archivedAt || team.workspaceId !== item.workspaceId) { fail(item.id, 'team_unavailable'); return null; }
      id = team.leaderId;
      if (!id) { fail(item.id, 'leader_missing'); return null; }
    }
    if (!id) { fail(item.id, 'execution_owner_missing'); return null; }
    const agent = ctx.agents().getAgent(id);
    facts.push(['agent', id, agent?.workspaceId, agent?.archivedAt]);
    if (!agent || agent.archivedAt || agent.workspaceId !== item.workspaceId) { fail(item.id, 'agent_unavailable'); return null; }
    return {type:'agent', id:agent.id, issueId:item.id, name:agent.name};
  };
  if (!issue) fail(issueId, 'issue_missing');
  while (issue) {
    if (seen.has(issue.id)) { fail(issue.id, 'parent_cycle'); break; }
    seen.add(issue.id);
    result.workspaceId ??= issue.workspaceId;
    if (issue.workspaceId !== result.workspaceId) { fail(issue.id, 'workspace_mismatch'); break; }
    facts.push(['issue', issue.id, issue.parentIssueId, issue.assigneeType, issue.assigneeId, issue.responsibleMemberId ?? null]);
    result.chain.push({issueId:issue.id, executionOwner:owner(issue)});
    if (!issue.parentIssueId) {
      result.rootIssueId = issue.id;
      const id = issue.responsibleMemberId;
      const human = id ? ctx.workspaces().getWorkspaceMember(id) : null;
      facts.push(['human', id, human?.workspaceId, human?.archivedAt]);
      if (!id) fail(issue.id, 'human_missing');
      else if (!human || human.archivedAt || human.workspaceId !== issue.workspaceId) fail(issue.id, 'human_unavailable');
      else result.rootHuman = {type:'member', id:human.id, issueId:issue.id, name:human.name};
      break;
    }
    const parentId: string = issue.parentIssueId;
    issue = ctx.issues().getIssue(parentId);
    if (!issue) fail(parentId, 'parent_missing');
  }
  result.executionOwner = result.chain[0]?.executionOwner ?? null;
  result.reviewOwner = result.chain.length > 1 ? result.chain[1]!.executionOwner : result.rootHuman;
  result.revision = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return result;
}
