/** Displayable audit actions; ordinary comment audits already have a log row. */
export const ISSUE_CONVERSATION_ACTIVITY_TYPES = [
  "issue_created", "issue_updated", "issue_assigned", "issue_unassigned",
  "label_attached", "label_detached", "title_renamed", "issue_status_forced",
  "parent_status_derived", "parent_status_held",
] as const;
export const ISSUE_SYSTEM_ACTIVITY_TYPES = [
  "dependency_created", "dependency_deleted", "dependency_ready", "dependency_failed",
  "decision_requested", "decision_answered", "decision_revised", "decision_cancelled",
  "child_status", "child_status_changed", "dispatch_skipped", "squad_leader_evaluated",
  "human_request", "waiting_on_human", "organizer_action", "task_failure", "task_cancelled",
  "quick_create_started", "quick_create_completed", "quick_create_failed", "issue_generated",
  "issue_metadata_updated",
  "delegation_return_triggered", "delegation_return_skipped", "child_done_parent_triggered",
  "child_status_parent_coalesced", "child_status_after_parent_closed", "child_done_parent_skipped",
  "decision_received", "decision_escalated", "decision_reminder", "decision_card_skipped",
  "decision_card_queued", "decision_card_reminder", "decision_card_degraded",
  "dependency_auto_started", "dependency_gate_exempted", "dependency_satisfied",
  "dependency_auto_start_skipped", "dependency_prerequisite_failed", "dependency_waiting",
  "dependency_force_started", "dependency_satisfied_coalesced",
  "parent_done_grant_created", "parent_done_grant_revoked", "parent_done_grant_used",
  "issue_dependency_added", "issue_dependency_removed", "issue_metadata_set", "issue_metadata_deleted",
  "quick_create_queued",
  "comment_mention_skipped", "comment_dispatch_replayed",
] as const;
export const ISSUE_ACTIVITY_TYPES: readonly string[] = [
  ...ISSUE_CONVERSATION_ACTIVITY_TYPES, ...ISSUE_SYSTEM_ACTIVITY_TYPES,
];
const conversation = new Set<string>(ISSUE_CONVERSATION_ACTIVITY_TYPES);
const system = new Set<string>(ISSUE_SYSTEM_ACTIVITY_TYPES);
export function issueActivityLayer(action: string): "conversation" | "system" | null {
  return conversation.has(action) ? "conversation" : system.has(action) ? "system" : null;
}

export interface IssueActivityEntry {
  type: "activity";
  id: string;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
  action: string;
  details: Record<string, unknown> | null;
}

export function issueActivityDetails(data: unknown, body: string | null): Record<string, unknown> | null {
  const details = data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown> : {};
  return body === null ? (Object.keys(details).length ? details : null) : { body, ...details };
}
