"use client";

import { STATUS_CONFIG, PRIORITY_CONFIG } from "@multiremi/core/issues/config";
import { formatDateOnly } from "@multiremi/core/issues/date";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { feishuInboxContext, feishuInboxOrigin } from "@multiremi/core/feishu/inbox";
import { StatusIcon, PriorityIcon } from "../../issues/components";
import type { InboxItem, InboxItemType, IssueStatus, IssuePriority } from "@multiremi/core/types";
import {
  autopilotDurationParts,
  getAutopilotRunOutcome,
  getInboxDisplayTitle,
  getQuickCreateFailureDetail,
} from "./inbox-display";
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
    feishu_message_notification: t(($) => $.types.feishu_message_notification),
    feishu_reply_draft: t(($) => $.types.feishu_reply_draft),
    feishu_issue_proposal: t(($) => $.types.feishu_issue_proposal),
    feishu_ingest_connection_alert: t(($) => $.types.feishu_ingest_connection_alert),
  };
}

/**
 * The headline for an inbox row. Structured autopilot rows are rebuilt in the
 * viewer's locale, while Feishu rows use the localized type label plus the chat
 * (or, for an alert, the source) the row came from. Other rows retain the title
 * sent by the server.
 *
 * The `"row"` variant carries the type label because a list row has no meta
 * line; the `"detail"` variant drops it because the panel already prints the
 * label under the heading.
 */
export function useInboxTitle(): (
  item: InboxItem,
  variant: "row" | "detail",
  runCount?: number,
) => string {
  const { t, i18n } = useT("inbox");
  const typeLabels = useTypeLabels();
  return (item, variant, runCount = 1) => {
    const context = feishuInboxContext(item);
    if (!context) {
      return getInboxDisplayTitle(item, {
        locale: i18n.resolvedLanguage ?? i18n.language,
        scheduled: (time) => t(($) => $.autopilot.scheduled, { time }),
        repeatedRuns: (title, count) => t(($) => $.autopilot.repeated_runs, { title, count }),
      }, runCount);
    }
    const label = typeLabels[item.type];
    const origin = feishuInboxOrigin(context);
    if (variant === "detail") return origin ?? label;
    return origin ? `${label} · ${origin}` : label;
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
        ? formatAutopilotDuration(details.duration_seconds, t)
        : null;
      let summary: string;
      if (outcome.kind === "no_change") {
        summary = t(($) => $.autopilot.no_change);
      } else if (outcome.kind === "failed") {
        summary = outcome.text
          ? t(($) => $.autopilot.failed_with_summary, { summary: outcome.text })
          : t(($) => $.autopilot.failed);
      } else if (outcome.kind === "unknown") {
        if (item.type === "autopilot_run_failed") {
          summary = outcome.text
            ? t(($) => $.autopilot.failed_with_summary, { summary: outcome.text })
            : t(($) => $.autopilot.failed);
        } else {
          summary = outcome.text
            ? t(($) => $.autopilot.completed_with_summary, { summary: outcome.text })
            : t(($) => $.autopilot.completed);
        }
      } else {
        const count = outcome.counts?.changes ?? outcome.links.length;
        summary = count > 0
          ? t(($) => $.autopilot.changes, { count })
          : outcome.text ?? t(($) => $.autopilot.completed);
      }
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span>{summary}</span>
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
    case "feishu_ingest_connection_alert": {
      // The server body is rendered in a single language; rebuild the line
      // from `details` so it follows the viewer's locale when it can.
      const context = feishuInboxContext(item);
      if (context?.sourceName && context.consecutiveFailures !== null) {
        return (
          <span>
            {t(($) => $.labels.feishu_source_failing, {
              source: context.sourceName,
              failures: context.consecutiveFailures,
            })}
          </span>
        );
      }
      if (item.body) return <span>{item.body}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    case "feishu_message_notification":
    case "feishu_reply_draft":
    case "feishu_issue_proposal": {
      if (item.body) return <span>{item.body}</span>;
      return <span>{typeLabels[item.type]}</span>;
    }
    default:
      return <span>{typeLabels[item.type] ?? item.type}</span>;
  }
}

function formatAutopilotDuration(
  seconds: number,
  t: ReturnType<typeof useT<"inbox">>["t"],
): string {
  const duration = autopilotDurationParts(seconds);
  if (duration.unit === "seconds") {
    return t(($) => $.autopilot.duration_seconds, { seconds: duration.seconds });
  }
  if (duration.unit === "minutes") {
    return t(($) => $.autopilot.duration_minutes, { minutes: duration.minutes });
  }
  return t(($) => $.autopilot.duration_hours, {
    hours: duration.hours,
    minutes: duration.minutes,
  });
}
