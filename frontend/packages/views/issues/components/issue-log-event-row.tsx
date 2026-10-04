"use client";

import { ChevronRight } from "lucide-react";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { EntryHtml } from "../../common/session-log/entry-html";
import { delegationBodyOutcome, delegationReporter, eventSummary, isInboxTurn, metadataRecord, metadataString, reportOutcome } from "../../common/session-log/event-summary";
import { ReadonlyContent } from "../../editor";
import { useT, useTimeAgo } from "../../i18n";

interface IssueLogEventRowProps {
  row: SessionLogRow;
  expanded: boolean;
  onToggle: () => void;
  getActorName: (type: string, id: string) => string;
  results: ReadonlyMap<string, SessionResult>;
  onShowKeyResults: () => void;
}

export function IssueLogEventRow({ row, expanded, onToggle, getActorName, results, onShowKeyResults }: IssueLogEventRowProps) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const agentName = (id: unknown) => eventSummary(getActorName("agent", metadataString(id))) || t($ => $.log_event.unknown_agent);
  const summary = eventSummary(row.body_md) || t($ => $.log_event.generic);
  let label = summary;
  let status = "";
  let expandable = false;
  let showResult = false;

  if (row.kind === "turn") {
    const assignee = agentName(row.metadata.assignee_agent_id);
    if (isInboxTurn(row.body_md)) {
      label = t($ => $.log_event.inbox_processed, { name: assignee });
    } else {
      expandable = true;
      label = row.author_type === "system"
        ? t($ => $.log_event.task_received, { assignee, summary })
        : t($ => $.log_event.task_assigned, {
          author: eventSummary(getActorName(row.author_type, row.author_id ?? "")) || t($ => $.log_event.unknown_author), assignee, summary,
        });
    }
    switch (row.metadata.status) {
      case "queued": status = t($ => $.execution_log.status_queued); break;
      case "dispatched": status = t($ => $.execution_log.status_dispatched); break;
      case "waiting_local_directory": status = t($ => $.execution_log.status_waiting_local_directory); break;
      case "running": status = t($ => $.execution_log.status_running); break;
      case "awaiting_human": status = t($ => $.execution_log.status_awaiting_human); break;
      case "completed": status = t($ => $.execution_log.status_completed); break;
      case "failed": status = t($ => $.execution_log.status_failed); break;
      case "cancelled": status = t($ => $.execution_log.status_cancelled); break;
    }
  } else if (row.kind === "result_published") {
    const result = results.get(metadataString(row.metadata.result_id));
    const title = eventSummary(metadataString(row.metadata.title) || result?.title || "") || t($ => $.detail.result_untitled);
    const publisher = result ? eventSummary(getActorName(result.published_by_type, result.published_by_id ?? "")) : "";
    label = `${publisher ? `${publisher} ` : ""}${t($ => $.detail.result_published_activity, { title })}`;
    showResult = true;
  } else if (row.kind === "system") {
    const envelope = metadataRecord(row.metadata.envelope);
    const bodyOutcome = delegationBodyOutcome(row.body_md);
    if (envelope.kind === "report" || bodyOutcome || (row.id.startsWith("cmt_env_") && !envelope.kind)) {
      const reporter = delegationReporter(row.body_md);
      const recipient = metadataString(envelope.recipient_agent_id);
      const named = Boolean(reporter && recipient);
      const names = { reporter, delegator: agentName(recipient) };
      switch (reportOutcome(envelope.outcome) ?? bodyOutcome) {
        case "completed": label = named ? t($ => $.log_event.delegation_completed, names) : t($ => $.log_event.delegation_completed_generic); break;
        case "failed": label = named ? t($ => $.log_event.delegation_failed, names) : t($ => $.log_event.delegation_failed_generic); break;
        case "cancelled": label = named ? t($ => $.log_event.delegation_cancelled, names) : t($ => $.log_event.delegation_cancelled_generic); break;
        default: label = t($ => $.log_event.delegation_updated);
      }
    }
  }

  const content = <>
    {expandable && <ChevronRight aria-hidden="true" className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {status && <span className="max-w-24 shrink-0 truncate">{status}</span>}
    {(row.kind === "turn" || showResult) && row.created_at && <time dateTime={row.created_at} className="max-w-24 shrink-0 truncate">{timeAgo(row.created_at)}</time>}
  </>;
  const lineClass = "flex h-8 w-full items-center gap-2 overflow-hidden text-left text-xs text-muted-foreground";
  return <div data-log-kind={row.kind}>
    {expandable || showResult
      ? <button type="button" className={`${lineClass} hover:text-foreground`}
        data-session-log-disclosure={expandable ? "" : undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable ? `log-event-body-${row.id}` : undefined}
        onClick={expandable ? onToggle : onShowKeyResults}>{content}</button>
      : <div className={lineClass} role="status">{content}</div>}
    {expandable && expanded && <div id={`log-event-body-${row.id}`} className="pb-3 text-sm leading-relaxed text-foreground [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-base [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_h1]:leading-normal [&_h2]:leading-normal [&_h3]:leading-normal">
      <EntryHtml html={row.body_html} markdown={row.body_md} fallback={<ReadonlyContent content={row.body_md} />} />
    </div>}
  </div>;
}
