import type { MultiremiStore } from './store.js';
import type { MultiremiTask } from '@multiremi/contracts/types.js';

/** Related controllers retain the same workspace boundary as the executing agent. */
export function isRelatedTurnController(store: MultiremiStore, agentId: string, target: MultiremiTask): boolean {
  const agent = store.getAgent(agentId);
  if (!agent || agent.archivedAt || agent.workspaceId !== target.workspaceId) return false;
  const issue = target.issueId ? store.getIssue(target.issueId) : null;
  const parent = issue?.parentIssueId ? store.getIssue(issue.parentIssueId) : null;
  const parentOwner = parent?.assigneeType === 'agent' ? parent.assigneeId
    : parent?.assigneeType === 'squad' ? store.getSquad(parent.assigneeId ?? '')?.leaderId : null;
  if (parent?.workspaceId === target.workspaceId && parentOwner === agentId) return true;
  return store.listSquads(target.workspaceId).some(squad => squad.leaderId === agentId
    && store.listSquadMembers(squad.id).some(member => member.memberType === 'agent' && member.memberId === target.agentId));
}
