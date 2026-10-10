"use client";

import { ChevronDown, ChevronRight, Diamond } from "lucide-react";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { eventSummary } from "../../common/session-log/event-summary";
import { useT, useTimeAgo } from "../../i18n";
import { formatActivity } from "../utils/format-activity";
import type { ActivityEvent, ActivityGroup } from "../utils/issue-activity-presentation";
import { IssueLogEventRow } from "./issue-log-event-row";

export function IssueActivityTrail({ group, expanded, showOlder, truncateOlder, onToggle, onShowOlder, getActorName, onOpenTask, taskAgents, results, onShowKeyResults, targetCommentId, highlightedId }: {
  group: ActivityGroup; expanded: boolean; showOlder: boolean; truncateOlder: boolean;
  onToggle: () => void; onShowOlder: () => void; getActorName: (type: string, id: string) => string;
  onOpenTask: (row: SessionLogRow) => void; taskAgents: ReadonlyMap<string, string>;
  results: ReadonlyMap<string, SessionResult>; onShowKeyResults: () => void;
  targetCommentId: string | null; highlightedId: string | null;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const summary = (event: ActivityEvent) => {
    if (event.kind === "log") return eventSummary(event.entry.body_md);
    const text = formatActivity(event.entry, t, getActorName);
    return event.entry.action === "workspace_move_cleared" ? text : eventSummary(text);
  };
  const hidden = expanded && truncateOlder && !showOlder ? Math.max(0, group.events.length - 8) : 0;
  const events = hidden ? group.events.slice(-8) : group.events;
  return <div data-activity-group={group.id} data-system-detail={group.system || undefined}>
    {group.collapsible && <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="flex h-8 w-full items-center gap-2 overflow-hidden text-left text-xs text-muted-foreground hover:text-foreground">
      <span className="flex w-6 shrink-0 justify-center">{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</span>
      <span className="min-w-0 flex-1 truncate">{t($ => $.activity.group_summary, { count: group.events.length, summary: summary(group.events[0]!) })}</span>
      <time className="max-w-20 shrink-0 truncate" dateTime={group.events.at(-1)!.entry.created_at}>{timeAgo(group.events.at(-1)!.entry.created_at)}</time>
    </button>}
    {(!group.collapsible || expanded) && <>
      {hidden > 0 && <button type="button" onClick={onShowOlder} className="flex h-8 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="mx-1.5 size-3 shrink-0" />{t($ => $.activity.show_more_activities, { count: hidden })}
      </button>}
      {events.map(event => event.kind === "log"
        ? <div key={event.entry.id} id={`comment-${event.entry.id}`}
            data-perf-anchor={targetCommentId === event.entry.id ? "target-comment" : undefined}
            className={`transition-colors duration-500 ${highlightedId === `comment-${event.entry.id}` ? "bg-warning/10" : ""}`}>
            <IssueLogEventRow row={event.entry} onOpenTask={onOpenTask}
            getActorName={getActorName} taskAgents={taskAgents} results={results} onShowKeyResults={onShowKeyResults} /></div>
        : <div key={event.entry.id} data-issue-activity={event.entry.id} role="status"
            className={`flex h-8 items-center gap-2 overflow-hidden text-xs ${group.system ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
            <span className="flex w-6 shrink-0 justify-center">{group.system ? <Diamond className="size-3" />
              : <ActorAvatar actorType={event.entry.actor_type} actorId={event.entry.actor_id} size={24} profileLink={false} />}</span>
            {group.system && <span className="shrink-0 border border-dashed border-border px-1 text-[10px] leading-4">{t($ => $.log_event.system)}</span>}
            <span className="min-w-0 flex-1 truncate">{eventSummary(getActorName(event.entry.actor_type, event.entry.actor_id)) || (group.system ? "" : t($ => $.log_event.system))} {summary(event)}</span>
            {(event.entry.coalesced_count ?? 1) > 1 && <span className="shrink-0 text-[10px]">{t($ => $.activity.coalesced_badge, { count: event.entry.coalesced_count })}</span>}
            <time dateTime={event.entry.created_at} className="max-w-20 shrink-0 truncate">{timeAgo(event.entry.created_at)}</time>
          </div>)}
    </>}
  </div>;
}
