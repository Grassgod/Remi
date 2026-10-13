/** An Issue's execution owner (执行负责人): its assigned Agent, or the assigned team's available Leader. */
export interface IssueResponsibleActor {
  type: 'agent';
  id: string;
  issueId: string;
  name: string;
}

export type IssueResponsibilityFailure = 'issue_missing' | 'parent_missing' | 'parent_cycle' | 'workspace_mismatch'
  | 'execution_owner_missing' | 'agent_unavailable' | 'team_unavailable' | 'leader_missing';

/** Issue ownership is independent from execution/delegation participants. No human is designated. */
export interface IssueResponsibility {
  issueId: string;
  workspaceId: string | null;
  executionOwner: IssueResponsibleActor | null;
  rootIssueId: string | null;
  /** From the current Issue to the root, retaining repeated owners for audit. */
  chain: Array<{ issueId: string; executionOwner: IssueResponsibleActor | null }>;
  unresolved: Array<{ issueId: string; reason: IssueResponsibilityFailure }>;
  /** Hashes only the execution-owner chain and its availability; never a timestamp heuristic. */
  revision: string;
}
