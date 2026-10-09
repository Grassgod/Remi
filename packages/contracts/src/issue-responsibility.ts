/** Issue ownership is independent from execution/delegation participants. */
export interface IssueResponsibleActor {
  type: 'agent' | 'member';
  id: string;
  issueId: string;
  name: string;
}

export type IssueResponsibilityFailure = 'issue_missing' | 'parent_missing' | 'parent_cycle' | 'workspace_mismatch'
  | 'execution_owner_missing' | 'agent_unavailable' | 'team_unavailable' | 'leader_missing'
  | 'human_missing' | 'human_unavailable';

export interface IssueResponsibility {
  issueId: string;
  workspaceId: string | null;
  executionOwner: IssueResponsibleActor | null;
  reviewOwner: IssueResponsibleActor | null;
  rootHuman: IssueResponsibleActor | null;
  rootIssueId: string | null;
  /** From the current Issue to the root, retaining repeated owners for audit. */
  chain: Array<{ issueId: string; executionOwner: IssueResponsibleActor | null }>;
  unresolved: Array<{ issueId: string; reason: IssueResponsibilityFailure }>;
  /** Changes when any ownership fact in the chain changes; never a timestamp heuristic. */
  revision: string;
}

export interface IssueDelivery {
  id: string;
  issueId: string;
  sourceSessionId: string;
  summary: string;
  status: 'pending' | 'accepted' | 'returned';
  submittedBy: IssueResponsibleActor;
  reviewOwner: IssueResponsibleActor;
  /** Current parent review availability; the persisted delivery and any settled receipt remain intact. */
  reviewUnavailableReason?: 'review_issue_closed' | 'review_issue_archived';
  responsibilityRevision: string;
  responseMessageId: string | null;
  responseBody: string | null;
  authorization?: { agentId: string; grantedBy: string; responsibilityRevision: string; grantedAt: string } | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface SubmitIssueDeliveryInput { summary: string; sessionId?: string; dedupeKey?: string }
export interface ListIssueDeliveriesInput { limit?: number; before?: string }
export interface RespondIssueDeliveryInput { action: 'accept' | 'return'; body?: string; revision: string }

export interface IssueResponsibilityMigrationItem {
  issueId: string; key: string; title: string; responsibleMemberId: string | null;
  assigneeType: string | null; assigneeId: string | null;
  createdById: string | null;
  revision: string; unresolved: IssueResponsibility['unresolved'];
  candidates: Array<{memberId:string;name:string;source:'legacy_member_assignee'|'historical_creator';available:boolean}>;
}
export interface IssueResponsibilityMigrationList {
  workspaceId:string; total:number; rootCount:number; legacyMemberExecutionCount:number;
  items:IssueResponsibilityMigrationItem[]; nextOffset:number|null;
}
export interface MapIssueResponsibilityInput {
  reason:string; mappings:Array<{issueId:string;memberId:string;revision:string}>;
}
