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
    default:
      return reason?.trim() || t(($) => $.activity.reason_unknown);
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
      return t(($) => $.activity.delegation_return_triggered);
    case "delegation_return_skipped":
      return t(($) => $.activity.delegation_return_skipped, {
        reason: delegationReturnReason(details.reason, t),
      });
    case "comment_mention_skipped":
      return t(($) => $.activity.comment_mention_skipped, {
        reason: commentMentionReason(details.reason, t),
      });
    case "dispatch_skipped": {
      if (details.reason === "no_runnable_agent") {
        return t(($) => $.activity.dispatch_skipped_no_runnable_agent);
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
