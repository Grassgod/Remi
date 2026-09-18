import type { Label } from "./label";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type IssuePriority = "urgent" | "high" | "medium" | "low" | "none";

export type IssueAssigneeType = "member" | "agent" | "squad";

export interface IssueReaction {
  id: string;
  issue_id: string;
  actor_type: string;
  actor_id: string;
  emoji: string;
  created_at: string;
}

/**
 * Per-issue metadata is a flat KV map agents use to record pipeline state
 * (PR number, pipeline_status, waiting_on, ...). Values are primitives only —
 * string / number / bool — enforced by both the API and the DB. Always
 * present in responses (empty object when unset) so reads don't need a
 * nil guard on the parent field.
 */
export type IssueMetadataValue = string | number | boolean;
export type IssueMetadata = Record<string, IssueMetadataValue>;

export interface Issue {
  runtime_workspace_id?: string | null;
  id: string;
  workspace_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_type: IssueAssigneeType | null;
  assignee_id: string | null;
  creator_type: IssueAssigneeType;
  creator_id: string;
  parent_issue_id: string | null;
  issue_kind?: "execution" | "intake";
  source_issue_id?: string | null;
  project_id: string | null;
  position: number;
  // Calendar days as date-only "YYYY-MM-DD" (no time, no timezone). Use the
  // helpers in @multiremi/core/issues/date to format/compare — never `new Date()`
  // + local formatting, which shifts the day by the viewer's offset.
  start_date: string | null;
  due_date: string | null;
  metadata: IssueMetadata;
  reactions?: IssueReaction[];
  labels?: Label[];
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type IssueWorkspaceStatus = "preparing" | "ready" | "in_use" | "dirty" | "runtime_offline" | "cleaned" | "error";

export interface IssueWorkspaceRepo {
  repo_url: string;
  repo_name: string;
  worktree_path: string;
  branch_name: string;
  base_ref: string;
  status: "ready" | "dirty" | "error";
  dirty: boolean;
  error: string | null;
}

export interface IssueWorkspace {
  issue_id: string;
  workspace_id: string;
  issue_key: string;
  runtime_id: string | null;
  runtime_name: string | null;
  runtime_status: "online" | "offline" | null;
  runtime_provider?: string | null;
  runtime_mode?: "local" | "cloud" | null;
  runtime_device_info?: string | null;
  runtime_daemon_id?: string | null;
  runtime_machine_name?: string | null;
  root_path: string;
  branch_name: string;
  status: IssueWorkspaceStatus;
  repos: IssueWorkspaceRepo[];
  last_task_id: string | null;
  cleaned_at: string | null;
  created_at: string;
  updated_at: string;
}
