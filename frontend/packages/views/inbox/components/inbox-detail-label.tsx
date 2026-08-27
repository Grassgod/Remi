"use client";

import { STATUS_CONFIG, PRIORITY_CONFIG } from "@multiremi/core/issues/config";
import { formatDateOnly } from "@multiremi/core/issues/date";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { StatusIcon, PriorityIcon } from "../../issues/components";
import type { InboxItem, InboxItemType, IssueStatus, IssuePriority } from "@multiremi/core/types";
import { getAutopilotRunOutcome, getQuickCreateFailureDetail } from "./inbox-display";
import { useT } from "../../i18n";

// Hook returning the inbox-item type → human label map. Replaces the
// previous static `typeLabels` const so the labels can flow through
// i18next. Call sites keep the same `typeLabels[type]` access pattern.
export function useTypeLabels(): Record<InboxItemType, string> {
  const { t } = useT("inbox");
  return {
    issue_assigned: t(($) => $.types.issue_assigned),
    unassigned: t(($) => $.types.unassigned),
    assignee_changed: t(($) => $.types.assignee_changed),
    status_changed: t(($) => $.types.status_changed),
    priority_changed: t(($) => $.types.priority_changed),
    start_date_changed: t(($) => $.types.start_date_changed),
    due_date_changed: t(($) => $.types.due_date_changed),
    new_comment: t(($) => $.types.new_comment),
    mentioned: t(($) => $.types.mentioned),
    comment_created: t(($) => $.types.comment_created),
    comment_mention: t(($) => $.types.comment_mention),
    review_requested: t(($) => $.types.review_requested),
    task_completed: t(($) => $.types.task_completed),
    task_failed: t(($) => $.types.task_failed),
    agent_blocked: t(($) => $.types.agent_blocked),
    agent_completed: t(($) => $.types.agent_completed),
    reaction_added: t(($) => $.types.reaction_added),
    quick_create_done: t(($) => $.types.quick_create_done),
    quick_create_failed: t(($) => $.types.quick_create_failed),
    autopilot_paused: t(($) => $.types.autopilot_paused),
    autopilot_run_completed: t(($) => $.types.autopilot_run_completed),
    autopilot_run_failed: t(($) => $.types.autopilot_run_failed),
    autopilot_run_overdue: t(($) => $.types.autopilot_run_overdue),
  };
}

// start_date / due_date are calendar days — format timezone-safely so the day
// never shifts with the viewer's offset (see @multiremi/core/issues/date).
function shortDate(dateStr: string): string {
  return formatDateOnly(dateStr, { month: "short", day: "numeric" }, "en-US");
}

export function InboxDetailLabel({ item }: { item: InboxItem }) {
  const { t } = useT("inbox");
  const typeLabels = useTypeLabels();
  const { getActorName } = useActorName();
  const details = item.details ?? {};

  switch (item.type) {
    case "status_changed": {
      if (!details.to) return <span>{typeLabels[item.type]}</span>;
      const label = STATUS_CONFIG[details.to as IssueStatus]?.label ?? details.to;
      return (
        <span className="inline-flex items-center gap-1">
          {t(($) => $.labels.set_status_to)}
          <StatusIcon status={details.to as IssueStatus} className="h-3 w-3" />
          {label}
        </span>
      );
    }
    case "priority_changed": {
      if (!details.to) return <span>{typeLabels[item.type]}</span>;
      const label = PRIORITY_CONFIG[details.to as IssuePriority]?.label ?? details.to;
      return (
        <span className="inline-flex items-center gap-1">
          {t(($) => $.labels.set_priority_to)}
          <PriorityIcon priority={details.to as IssuePriority} className="h-3 w-3" />
          {label}
        </span>
      );
    }
    case "issue_assigned": {
      if (details.new_assignee_id) {
        return <span>{t(($) => $.labels.assigned_to, { name: getActorName(details.new_assignee_type ?? "member", details.new_assignee_id) })}</span>;
      }
      return <span>{typeLabels[item.type]}</span>;
    }
    case "unassigned":
      return <span>{t(($) => $.labels.removed_assignee)}</span>;
    case "assignee_changed": {
      if (details.new_assignee_id) {
        return <span>{t(($) => $.labels.assigned_to, { name: getActorName(details.new_assignee_type ?? "member", details.new_assignee_id) })}</span>;
      }
      return <span>{typeLabels[item.type]}</span>;
    }
    case "start_date_changed": {
      if (details.to) return <span>{t(($) => $.labels.set_start_date_to, { date: shortDate(details.to) })}</span>;
      return <span>{t(($) => $.labels.removed_start_date)}</span>;
    }
    case "due_date_changed": {
      if (details.to) return <span>{t(($) => $.labels.set_due_date_to, { date: shortDate(details.to) })}</span>;
      return <span>{t(($) => $.labels.removed_due_date)}</span>;
    }
    case "new_comment": {
      if (item.body) return <span>{item.body}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    case "comment_created":
    case "comment_mention":
    case "autopilot_paused":
    case "autopilot_run_overdue": {
      if (item.body) return <span>{item.body}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    case "autopilot_run_completed":
    case "autopilot_run_failed": {
      const outcome = getAutopilotRunOutcome(item);
      if (!outcome) {
        if (item.body) return <span>{item.body}</span>;
        return <span>{typeLabels[item.type]}</span>;
      }
      const duration = typeof details.duration_seconds === "number"
        ? t(($) => $.autopilot.duration, { seconds: details.duration_seconds })
        : null;
      let summary: string;
      if (outcome.kind === "no_change") {
        summary = t(($) => $.autopilot.no_change);
      } else if (outcome.kind === "failed") {
        summary = outcome.text
          ? t(($) => $.autopilot.failed_with_summary, { summary: outcome.text })
          : t(($) => $.autopilot.failed);
      } else if (outcome.kind === "unknown") {
        summary = item.type === "autopilot_run_failed"
          ? t(($) => $.autopilot.failed)
          : t(($) => $.autopilot.completed);
      } else {
        const count = outcome.counts?.changes ?? outcome.links.length;
        summary = count > 0
          ? t(($) => $.autopilot.changes, { count })
          : outcome.text ?? t(($) => $.autopilot.completed);
      }
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span>{summary}</span>
          {outcome.kind === "changes" && outcome.links.length === 0 && outcome.text && (
            <span className="truncate">· {outcome.text}</span>
          )}
          {outcome.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-foreground underline underline-offset-2"
              onClick={(event) => event.stopPropagation()}
            >
              {link.kind === "pull_request"
                ? t(($) => $.autopilot.pull_request, { number: link.number ?? "" })
                : t(($) => $.autopilot.merge_request, { number: link.number ?? "" })}
            </a>
          ))}
          {duration && <span className="shrink-0">· {duration}</span>}
        </span>
      );
    }
    case "reaction_added": {
      const emoji = details.emoji;
      if (emoji) return <span>{t(($) => $.labels.reacted_to_comment, { emoji })}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    case "quick_create_done": {
      const identifier = details.identifier;
      if (identifier) return <span>{t(($) => $.labels.created_with_agent, { identifier })}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    case "quick_create_failed": {
      const detail = getQuickCreateFailureDetail(item);
      if (detail) return <span>{t(($) => $.labels.failed_with_detail, { detail })}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    default:
      return <span>{typeLabels[item.type] ?? item.type}</span>;
  }
}
