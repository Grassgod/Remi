"use client";

import { TurnControls } from "../../common/turn-controls";
import { ArrowRight, Diamond } from "lucide-react";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { envelopeType, eventSummary, isInboxTurn, metadataRecord, metadataString, reportOutcome } from "../../common/session-log/event-summary";
import { formatElapsedMs } from "../../common/format";
import { useT, useTimeAgo } from "../../i18n";
import { assignmentAuthor, isSystemDetail } from "./issue-log-presentation";

interface IssueLogEventRowProps {
  row: SessionLogRow;
  onOpenTask: (row: SessionLogRow) => void;
  getActorName: (type: string, id: string) => string;
  taskAgents: ReadonlyMap<string, string>;
  results: ReadonlyMap<string, SessionResult>;
  onShowKeyResults: () => void;
}

export function IssueLogEventRow({ row, onOpenTask, getActorName, taskAgents, results, onShowKeyResults }: IssueLogEventRowProps) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const agentName = (id: unknown) => eventSummary(getActorName("agent", metadataString(id))) || t($ => $.log_event.unknown_agent);
  const system = isSystemDetail(row);
  const envelope = metadataRecord(row.metadata.envelope);
  const summary = eventSummary(row.body_md) || t($ => $.log_event.generic);
  let label = summary;
  let status = "";
  let duration = "";
  let action: (() => void) | undefined;

  if (row.metadata.envelope || row.id.startsWith("cmt_env_")) {
    const recipient = eventSummary(getActorName("agent", metadataString(envelope.recipient_agent_id)));
    const type = envelopeType(envelope);
    const outcome = reportOutcome(envelope.outcome);
    const source = metadataRecord(envelope.source);
    const reporter = taskAgents.get(metadataString(source.taskId));
    const name = reporter ? eventSummary(getActorName("agent", reporter)) : "";
    const values = { notification: recipient ? t($ => $.log_event.envelope_recipient, { name: recipient }) : t($ => $.log_event.envelope_notice), reporter: name };
    switch (type) {
      case "delegation":
        label = outcome === "completed" ? (name ? t($ => $.log_event.envelope_delegation_completed, values) : t($ => $.log_event.envelope_delegation_completed_generic, values))
          : outcome === "failed" ? (name ? t($ => $.log_event.envelope_delegation_failed, values) : t($ => $.log_event.envelope_delegation_failed_generic, values))
          : outcome === "cancelled" ? (name ? t($ => $.log_event.envelope_delegation_cancelled, values) : t($ => $.log_event.envelope_delegation_cancelled_generic, values))
          : t($ => $.log_event.envelope_delegation_progress, values);
        break;
      case "child": label = outcome === "completed" ? t($ => $.log_event.envelope_child_completed, values)
        : outcome === "failed" ? t($ => $.log_event.envelope_child_failed, values)
        : outcome === "cancelled" ? t($ => $.log_event.envelope_child_cancelled, values) : t($ => $.log_event.envelope_child_updated, values); break;
      case "dependency_failed": label = t($ => $.log_event.envelope_dependency_failed, values); break;
      case "dependency_ready": label = t($ => $.log_event.envelope_dependency_ready, values); break;
      case "decision_needed": label = t($ => $.log_event.envelope_decision_needed, values); break;
      case "decision_answer": label = t($ => $.log_event.envelope_decision_answer, values); break;
      case "delegation_progress": label = t($ => $.log_event.envelope_delegation_progress, values); break;
      case "relay": label = t($ => $.log_event.envelope_relay, values); break;
      default: label = t($ => $.log_event.envelope_generic, values);
    }
  } else if (row.kind === "turn") {
    const assignee = agentName(row.metadata.assignee_agent_id);
    if (isInboxTurn(row.body_md)) {
      label = t($ => $.log_event.inbox_view, { name: assignee });
    } else {
      const author = assignmentAuthor(row);
      label = author ? t($ => $.log_event.task_assigned, {
        author: eventSummary(getActorName(author.type, author.id)) || t($ => $.log_event.unknown_author), assignee, summary,
      }) : t($ => $.log_event.task_received, { assignee, summary });
      if (row.task_id) action = () => onOpenTask(row);
      switch (row.metadata.status) {
        case "completed": status = t($ => $.execution_log.status_completed); break;
        case "failed": status = t($ => $.execution_log.status_failed); break;
        case "cancelled": status = t($ => $.execution_log.status_cancelled); break;
        default: status = t($ => $.execution_log.status_running);
      }
      if (typeof row.metadata.elapsed_ms === "number" && Number.isFinite(row.metadata.elapsed_ms)) duration = formatElapsedMs(row.metadata.elapsed_ms);
    }
  } else if (row.kind === "result_published") {
    const result = results.get(metadataString(row.metadata.result_id));
    const title = eventSummary(metadataString(row.metadata.title) || result?.title || "") || t($ => $.detail.result_untitled);
    const publisher = result ? eventSummary(getActorName(result.published_by_type, result.published_by_id ?? "")) : "";
    label = `${publisher ? `${publisher} ` : ""}${t($ => $.detail.result_published_activity, { title })}`;
    action = onShowKeyResults;
  }

  const content = <>
    <span className="flex w-6 shrink-0 justify-center" aria-hidden="true">{system ? <Diamond className="size-3" /> : <ArrowRight className="size-3" />}</span>
    {system && <span className="shrink-0 border border-dashed border-border px-1 text-[10px] leading-4">{t($ => $.log_event.system)}</span>}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {status && <span className={`max-w-36 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] ${row.metadata.status === "completed" ? "bg-green-500/10 text-green-700 dark:text-green-400" : row.metadata.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
      {status}{duration && ` · ${duration}`}
    </span>}
    {row.created_at && <time dateTime={row.created_at} className="max-w-20 shrink-0 truncate">{timeAgo(row.created_at)}</time>}
  </>;
  const lineClass = `flex h-8 w-full items-center gap-2 overflow-hidden text-left text-xs ${system ? "text-muted-foreground/60" : "text-muted-foreground"}`;
  return <div data-log-kind={row.kind} data-system-detail={system || undefined}>
    {action ? <button type="button" className={`${lineClass} hover:text-foreground`} onClick={action}>{content}</button>
      : <div className={lineClass} role="status">{content}</div>}
    {row.kind === "turn" && <TurnControls turnId={typeof row.metadata.turn_id === "string" ? row.metadata.turn_id : row.id} />}
  </div>;
}
