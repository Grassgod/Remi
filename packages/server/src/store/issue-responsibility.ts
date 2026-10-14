import { createHash } from 'node:crypto';
import type { IssueResponsibility, IssueResponsibleActor } from '@multiremi/contracts';
import type { StoreContext } from './context.js';

/** A refused execution-owner or done-rule decision; routes surface `code` with `status`. */
export class IssueResponsibilityError extends Error {
  constructor(public code: string, message: string, public status: 403 | 404 | 409 = 409) { super(message); }
}

/** The only responsibility resolver: no sender-team, runnable-member or workspace-owner fallback, and no designated human. */
export function resolveIssueResponsibility(ctx: StoreContext, issueId: string): IssueResponsibility {
  const result: IssueResponsibility = { issueId, workspaceId: null, executionOwner: null, rootIssueId: null, chain: [], unresolved: [], revision: '' };
  const facts: unknown[] = [];
  const seen = new Set<string>();
  // Only current execution-owner facts participate. Labels, usage, prompts,
  // Agent Skills and the deprecated responsible_member_id column cannot change
  // the route or its revision.
  type IssueFacts = { id: string; workspaceId: string; parentIssueId: string | null; assigneeType: string | null; assigneeId: string | null };
  const readIssue = (id: string): IssueFacts | null => {
    const row = ctx.db.query('SELECT id,workspace_id,parent_issue_id,assignee_type,assignee_id FROM multiremi_issues WHERE id=?').get(id);
    return row ? { id: row.id, workspaceId: row.workspace_id, parentIssueId: row.parent_issue_id,
      assigneeType: row.assignee_type, assigneeId: row.assignee_id } : null;
  };
  let issue = readIssue(issueId);
  const fail = (id: string, reason: IssueResponsibility['unresolved'][number]['reason']) => result.unresolved.push({issueId: id, reason});
  const owner = (item: IssueFacts): IssueResponsibleActor | null => {
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
    const agent = ctx.agents().getAgentLite(id);
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
    facts.push(['issue', issue.id, issue.parentIssueId, issue.assigneeType, issue.assigneeId]);
    result.chain.push({issueId:issue.id, executionOwner:owner(issue)});
    if (!issue.parentIssueId) { result.rootIssueId = issue.id; break; }
    const parentId: string = issue.parentIssueId;
    issue = readIssue(parentId);
    if (!issue) fail(parentId, 'parent_missing');
  }
  result.executionOwner = result.chain[0]?.executionOwner ?? null;
  result.revision = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return result;
}
