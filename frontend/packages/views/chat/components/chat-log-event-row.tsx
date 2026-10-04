"use client";

import { useWorkspacePaths } from "@multiremi/core/paths";
import { chatIssueUpdate, eventSummary } from "../../common/session-log/event-summary";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

export function ChatLogEventRow({ markdown, metadata }: { markdown: string; metadata?: Record<string, unknown> }) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();
  const update = chatIssueUpdate(markdown, metadata);
  let label = eventSummary(markdown) || t($ => $.message_list.event_generic);
  if (update) {
    switch (update.outcome) {
      case "completed": label = t($ => $.message_list.issue_update_completed, { key: update.key }); break;
      case "failed": label = t($ => $.message_list.issue_update_failed, { key: update.key }); break;
      case "cancelled": label = t($ => $.message_list.issue_update_cancelled, { key: update.key }); break;
      default: label = t($ => $.message_list.issue_update, { key: update.key });
    }
  }
  const className = "block h-8 truncate text-xs leading-8 text-muted-foreground";
  return update?.issueId
    ? <AppLink href={paths.issueDetail(update.issueId)} className={`${className} hover:text-foreground`}>{label}</AppLink>
    : <div className={className} role="status">{label}</div>;
}
