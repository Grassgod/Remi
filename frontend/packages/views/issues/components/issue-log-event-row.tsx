"use client";

import { TurnControls } from "../../common/turn-controls";
import { ArrowRight, Diamond } from "lucide-react";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { eventSummary, metadataString } from "../../common/session-log/event-summary";
import { formatElapsedMs } from "../../common/format";
import { useT, useTimeAgo } from "../../i18n";
import { assignmentAuthor, isSystemDetail } from "./issue-log-presentation";
import { systemLogSummary } from "./issue-log-summary";

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
  const summary = eventSummary(row.body_md) || t($ => $.log_event.generic);
  let label = summary;
  let status = "";
  let duration = "";
  let action: (() => void) | undefined;

  if (row.metadata.envelope || row.id.startsWith("cmt_env_")) {
    label = systemLogSummary(row, getActorName, taskAgents, results, t);
  } else if (row.kind === "turn") {
    const assignee = agentName(row.metadata.assignee_agent_id);
    if (system) {
      label = systemLogSummary(row, getActorName, taskAgents, results, t);
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
    label = systemLogSummary(row, getActorName, taskAgents, results, t);
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
