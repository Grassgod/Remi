import type { IssueStatus } from "./issue";

export type InboxSeverity = "action_required" | "attention" | "info";

export type InboxItemType =
  | "issue_assigned"
  | "unassigned"
  | "assignee_changed"
  | "status_changed"
  | "priority_changed"
  | "start_date_changed"
  | "due_date_changed"
  | "new_comment"
  | "mentioned"
  | "comment_created"
  | "comment_mention"
  | "review_requested"
  | "task_completed"
  | "task_failed"
  | "agent_blocked"
  | "agent_completed"
  | "reaction_added"
  | "quick_create_done"
  | "quick_create_failed"
  | "autopilot_paused"
  | "autopilot_run_completed"
  | "autopilot_run_failed"
  | "autopilot_run_overdue"
  | "feishu_message_notification"
  | "feishu_reply_draft"
  | "feishu_issue_proposal"
  | "feishu_ingest_connection_alert";

export interface AutopilotRunTriggerObject {
  event_type: string | null;
  repository_id: string | null;
  repository_name: string | null;
  change_number: number | null;
  change_title: string | null;
  target_branch: string | null;
  source_revision: string | null;
  occurred_at: string | null;
  wiki_build: boolean;
}

export interface AutopilotRunOutcomeLink {
  kind: "pull_request" | "merge_request";
  url: string;
  number?: number;
}

export interface AutopilotRunOutcomeAction {
  kind: "none" | "review" | "retry" | "investigate";
  text: string | null;
}

export interface AutopilotRunOutcome {
  kind: "no_change" | "changes" | "failed" | "unknown";
  headline: string | null;
  text: string | null;
  links: AutopilotRunOutcomeLink[];
  counts: Record<string, number> | null;
  risks: string[];
  action: AutopilotRunOutcomeAction | null;
}

export interface InboxItemDetails extends Record<string, unknown> {
  agent_id?: string;
  autopilot_id?: string;
  autopilot_title?: string;
  comment_id?: string;
  duration_seconds?: number;
  emoji?: string;
  error?: string;
  identifier?: string;
  issue_id?: string | null;
  issue_session_id?: string;
  new_assignee_id?: string;
  new_assignee_type?: string;
  original_prompt?: string;
  outcome?: AutopilotRunOutcome;
  run_id?: string;
  task_id?: string;
  to?: string;
  trigger?: string;
  trigger_object?: AutopilotRunTriggerObject | null;
  triggered_at?: string;
}

export interface InboxItem {
  id: string;
  workspace_id: string;
  recipient_type: "member" | "agent";
  recipient_id: string;
  actor_type: "member" | "agent" | "system" | null;
  actor_id: string | null;
  type: InboxItemType;
  severity: InboxSeverity;
  issue_id: string | null;
  title: string;
  body: string | null;
  issue_status: IssueStatus | null;
  read: boolean;
  archived: boolean;
  created_at: string;
  details: InboxItemDetails | null;
}

export interface InboxPage {
  items: InboxItem[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface InboxSummary {
  unread: number;
  attention: number;
}
