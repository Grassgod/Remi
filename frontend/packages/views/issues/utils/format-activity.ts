import type { IssueStatus, IssuePriority, TimelineEntry } from "@multiremi/core/types";
import { STATUS_CONFIG, PRIORITY_CONFIG } from "@multiremi/core/issues/config";
import { formatDateOnly } from "@multiremi/core/issues/date";
import type { useT } from "../../i18n";

export type IssuesT = ReturnType<typeof useT<"issues">>["t"];

function delegationReturnReason(reason: string | undefined, t: IssuesT): string {
  switch (reason) {
    case "no_lineage":
      return t(($) => $.activity.delegation_return_reason_no_lineage);
    case "delegator_unavailable":
      return t(($) => $.activity.delegation_return_reason_delegator_unavailable);
    case "already_covered":
      return t(($) => $.activity.delegation_return_reason_already_covered);
    case "coalesced_into_pending_return":
      return t(($) => $.activity.delegation_return_reason_coalesced_into_pending_return);
    case "covered_by_queued_task":
      return t(($) => $.activity.delegation_return_reason_covered_by_queued_task);
    case "deferred_lane_busy":
      return t(($) => $.activity.delegation_return_reason_deferred_lane_busy);
    case "source_not_issue_task":
      return t(($) => $.activity.delegation_return_reason_source_not_issue_task);
    case "source_side_session":
      return t(($) => $.activity.delegation_return_reason_source_side_session);
    case "source_not_squad_leader":
      return t(($) => $.activity.delegation_return_reason_source_not_squad_leader);
    case "target_not_squad_member":
      return t(($) => $.activity.delegation_return_reason_target_not_squad_member);
    case "cross_issue_no_lineage":
      return t(($) => $.activity.delegation_return_reason_cross_issue_no_lineage);
    case "self_dispatch":
      return t(($) => $.activity.delegation_return_reason_self_dispatch);
    case "covered_by_delegate_wakeup":
      return t(($) => $.activity.delegation_return_reason_covered_by_delegate_wakeup);
    case "delegator_issue_closed":
      return t(($) => $.activity.delegation_return_reason_delegator_issue_closed);
    case "delegator_session_missing":
      return t(($) => $.activity.delegation_return_reason_delegator_session_missing);
    default:
      return reason?.trim() || t(($) => $.activity.reason_unknown);
  }
}

function childDoneParentReason(reason: string | undefined, t: IssuesT): string {
  switch (reason) {
    case "no_assignee":
      return t(($) => $.activity.child_done_parent_reason_no_assignee);
    case "agent_unavailable":
      return t(($) => $.activity.child_done_parent_reason_agent_unavailable);
    case "squad_leader_unavailable":
      return t(($) => $.activity.child_done_parent_reason_squad_leader_unavailable);
    default:
      return reason?.trim() || t(($) => $.activity.reason_unknown);
  }
}

/** MUL-400 E2: the four child endings, in the activity copy's vocabulary. */
function childOutcomeLabel(outcome: string | undefined, t: IssuesT): string {
  switch (outcome) {
    case "done":
      return t(($) => $.activity.child_outcome_done);
    case "failed":
      return t(($) => $.activity.child_outcome_failed);
    case "blocked":
      return t(($) => $.activity.child_outcome_blocked);
    case "cancelled":
      return t(($) => $.activity.child_outcome_cancelled);
    default:
      return outcome?.trim() || t(($) => $.activity.reason_unknown);
  }
}

function commentMentionReason(reason: string | undefined, t: IssuesT): string {
  switch (reason) {
    case "self_mention":
      return t(($) => $.activity.comment_mention_reason_self_mention);
    case "unsupported_direction":
      return t(($) => $.activity.comment_mention_reason_unsupported_direction);
    case "unlinked_agent_comment":
      return t(($) => $.activity.comment_mention_reason_unlinked_agent_comment);
    case "target_unavailable":
      return t(($) => $.activity.comment_mention_reason_target_unavailable);
    case "dependencies_unmet":
      // MUL-400 E3 gate 3: the mention landed but the issue is still waiting.
      return t(($) => $.activity.dependency_gate_reason_dependencies_unmet);
    default:
      return reason?.trim() || t(($) => $.activity.reason_unknown);
  }
}

export function statusLabel(status: string, t: IssuesT): string {
  if (status in STATUS_CONFIG) {
    return t(($) => $.status[status as IssueStatus]);
  }
  return status;
}

export function priorityLabel(priority: string, t: IssuesT): string {
  if (priority in PRIORITY_CONFIG) {
    return t(($) => $.priority[priority as IssuePriority]);
  }
  return priority;
}

export function formatActivity(
  entry: TimelineEntry,
  t: IssuesT,
  resolveActorName?: (type: string, id: string) => string,
): string {
  const details = (entry.details ?? {}) as Record<string, string>;
  switch (entry.action) {
    case "created":
      return t(($) => $.activity.created);
    case "status_changed":
      return t(($) => $.activity.status_changed, {
        from: statusLabel(details.from ?? "?", t),
        to: statusLabel(details.to ?? "?", t),
      });
    case "priority_changed":
      return t(($) => $.activity.priority_changed, {
        from: priorityLabel(details.from ?? "?", t),
        to: priorityLabel(details.to ?? "?", t),
      });
    case "assignee_changed": {
      const isSelfAssign = details.to_type === entry.actor_type && details.to_id === entry.actor_id;
      if (isSelfAssign) return t(($) => $.activity.self_assigned);
      const toName = details.to_id && details.to_type && resolveActorName
        ? resolveActorName(details.to_type, details.to_id)
        : null;
      if (toName) return t(($) => $.activity.assigned_to, { name: toName });
      if (details.from_id && !details.to_id) return t(($) => $.activity.removed_assignee);
      return t(($) => $.activity.changed_assignee);
    }
    case "start_date_changed": {
      if (!details.to) return t(($) => $.activity.start_date_removed);
      const formatted = formatDateOnly(details.to, { month: "short", day: "numeric" }, "en-US");
      return t(($) => $.activity.start_date_set, { date: formatted });
    }
    case "due_date_changed": {
      if (!details.to) return t(($) => $.activity.due_date_removed);
      const formatted = formatDateOnly(details.to, { month: "short", day: "numeric" }, "en-US");
      return t(($) => $.activity.due_date_set, { date: formatted });
    }
    case "title_changed":
    case "title_renamed":
      return t(($) => $.activity.title_renamed, {
        from: details.from ?? "?",
        to: details.to ?? "?",
      });
    case "description_updated":
      return t(($) => $.activity.description_updated);
    case "task_completed":
      return t(($) => $.activity.task_completed, { count: entry.coalesced_count ?? 1 });
    case "task_failed":
      return t(($) => $.activity.task_failed, { count: entry.coalesced_count ?? 1 });
    case "delegation_return_triggered":
      if (details.sourceIssueKey && details.sourceIssueId !== details.returnIssueId) {
        return t(($) => $.activity.delegation_return_triggered_cross_issue, { key: details.sourceIssueKey });
      }
      return t(($) => $.activity.delegation_return_triggered);
    case "delegation_return_skipped":
      return t(($) => $.activity.delegation_return_skipped, {
        reason: delegationReturnReason(details.reason, t),
      });
    case "child_done_parent_triggered":
      return t(($) => $.activity.child_done_parent_triggered);
    case "child_status_parent_coalesced":
      return t(($) => $.activity.child_status_parent_coalesced);
    case "parent_status_held":
      return t(($) => details.reason === "grant_missing"
        ? $.activity.parent_status_held_grant_missing
        : details.reason === "final_summary_missing"
          ? $.activity.parent_status_held_final_summary_missing
          : $.activity.parent_status_held, {
        status: statusLabel(details.requested ?? details.status ?? "?", t),
      });
    case "parent_done_grant_created":
      return t(($) => $.activity.parent_done_grant_created, {
        agent: details.agentId && resolveActorName ? resolveActorName("agent", details.agentId) : details.agentId ?? "?",
      });
    case "parent_done_grant_revoked":
      return t(($) => $.activity.parent_done_grant_revoked);
    case "parent_done_grant_used":
      return t(($) => $.activity.parent_done_grant_used, {
        source: details.source === "scm_merge"
          ? t(($) => $.activity.parent_done_grant_source_scm_merge)
          : t(($) => $.activity.parent_done_grant_source_api),
      });
    case "parent_status_derived":
      return t(($) => $.activity.parent_status_derived);
    case "child_status_after_parent_closed":
      return t(($) => $.activity.child_status_after_parent_closed, {
        key: details.childIssueKey ?? details.child_issue_key ?? "?",
        outcome: childOutcomeLabel(details.outcome, t),
      });
    case "issue_status_forced":
      return t(($) => $.activity.issue_status_forced, {
        status: statusLabel(details.status ?? "?", t),
      });
    // MUL-400 E3: dependency gate and automatic start.
    case "dependency_auto_started":
      return t(($) => $.activity.dependency_auto_started, { key: details.satisfiedByKey ?? details.satisfied_by_key ?? "?" });
    case "dependency_gate_exempted": {
      const sourceLabels: Record<string, string> = {
        redispatch: t(($) => $.activity.dependency_gate_exempted_redispatch),
        retry: t(($) => $.activity.dependency_gate_exempted_retry),
        continuation: t(($) => $.activity.dependency_gate_exempted_continuation),
        delegation_return: t(($) => $.activity.dependency_gate_exempted_delegation_return),
        parent_wakeup: t(($) => $.activity.dependency_gate_exempted_parent_wakeup),
      };
      return t(($) => $.activity.dependency_gate_exempted, {
        source: sourceLabels[String(details.source)] ?? String(details.source ?? "?"),
      });
    }
    case "dependency_satisfied":
      return t(($) => $.activity.dependency_satisfied, { key: details.satisfiedByKey ?? details.satisfied_by_key ?? "?" });
    case "dependency_auto_start_skipped":
      return t(($) => $.activity.dependency_auto_start_skipped, { key: details.satisfiedByKey ?? details.satisfied_by_key ?? "?" });
    case "dependency_prerequisite_failed":
      return t(($) => $.activity.dependency_prerequisite_failed, {
        key: details.prerequisiteKey ?? details.prerequisite_key ?? "?",
      });
    case "dependency_waiting":
      return t(($) => $.activity.dependency_waiting);
    case "dependency_force_started": {
      if (details.source === "comment") {
        return t(($) => $.activity.dependency_force_started_comment);
      }
      if (details.source === "mention") {
        const agentId = details.agentId ?? details.agent_id;
        const agent = agentId && resolveActorName
          ? resolveActorName("agent", agentId)
          : agentId ?? "?";
        return t(($) => $.activity.dependency_force_started_mention, { agent });
      }
      if (details.source === "rerun") {
        return t(($) => $.activity.dependency_force_started_rerun);
      }
      return t(($) => $.activity.dependency_force_started);
    }
    case "dependency_satisfied_coalesced":
      return t(($) => $.activity.dependency_satisfied_coalesced);
    case "child_done_parent_skipped":
      return t(($) => $.activity.child_done_parent_skipped, {
        reason: childDoneParentReason(details.reason, t),
      });
    case "comment_mention_skipped":
      return t(($) => $.activity.comment_mention_skipped, {
        reason: commentMentionReason(details.reason, t),
      });
    case "dispatch_skipped": {
      if (details.reason === "no_runnable_agent") {
        return t(($) => $.activity.dispatch_skipped_no_runnable_agent);
      }
      if (details.reason === "member_assignee") {
        return t(($) => $.activity.dispatch_skipped_member_assignee);
      }
      if (details.reason === "no_assignee") {
        return t(($) => $.activity.dispatch_skipped_no_assignee);
      }
      // MUL-400 E3: the dependency hold has its own copy instead of showing the
      // raw reason string.
      if (details.reason === "dependencies_unmet") {
        return t(($) => $.activity.dependency_gate_reason_dependencies_unmet);
      }
      const error = details.error?.trim();
      return error
        ? t(($) => $.activity.dispatch_skipped_reason, { reason: error })
        : t(($) => $.activity.dispatch_skipped);
    }
    case "squad_leader_evaluated": {
      const reason = details.reason?.trim();
      switch (details.outcome) {
        case "action":
          return reason
            ? t(($) => $.activity.squad_leader_action_reason, { reason })
            : t(($) => $.activity.squad_leader_action);
        case "no_action":
          return reason
            ? t(($) => $.activity.squad_leader_no_action_reason, { reason })
            : t(($) => $.activity.squad_leader_no_action);
        case "failed":
          return reason
            ? t(($) => $.activity.squad_leader_failed_reason, { reason })
            : t(($) => $.activity.squad_leader_failed);
        default:
          return t(($) => $.activity.squad_leader_evaluated);
      }
    }
    default:
      return entry.action ?? "";
  }
}
