"use client";

import { useState } from "react";
import { StatusIcon } from "../../issues/components";
import { ActorAvatar } from "../../common/actor-avatar";
import { Archive, ChevronDown, ChevronRight } from "lucide-react";
import type { InboxItem } from "@multiremi/core/types";
import { InboxDetailLabel } from "./inbox-detail-label";
import { getInboxDisplayTitle } from "./inbox-display";
import { useT } from "../../i18n";

// Hook returning a localized relative-time formatter — the i18n equivalent
// of the previous static `timeAgo` function. Returning a function (rather
// than a string) keeps call-site usage identical: `timeAgo(dateStr)`.
export function useTimeAgo() {
  const { t } = useT("inbox");
  return (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t(($) => $.list.time.just_now);
    if (minutes < 60) return t(($) => $.list.time.minutes, { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t(($) => $.list.time.hours, { count: hours });
    const days = Math.floor(hours / 24);
    return t(($) => $.list.time.days, { count: days });
  };
}

export function InboxListItem({
  item,
  groupedItems = [item],
  isSelected,
  onClick,
  onItemClick,
  onArchive,
}: {
  item: InboxItem;
  groupedItems?: InboxItem[];
  isSelected: boolean;
  onClick: () => void;
  onItemClick?: (item: InboxItem) => void;
  onArchive: () => void;
}) {
  const { t, i18n } = useT("inbox");
  const timeAgo = useTimeAgo();
  const [expanded, setExpanded] = useState(false);
  const merged = groupedItems.length > 1;
  const read = groupedItems.every((entry) => entry.read);
  const localizer = {
    locale: i18n.resolvedLanguage ?? i18n.language,
    scheduled: (time: string) => t(($) => $.autopilot.scheduled, { time }),
    repeatedRuns: (title: string, count: number) =>
      t(($) => $.autopilot.repeated_runs, { title, count }),
  };
  const displayTitle = getInboxDisplayTitle(item, localizer, groupedItems.length);

  const handleRowKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleRowKeyDown}
        className={`group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          isSelected ? "bg-accent" : "hover:bg-accent/50"
        }`}
      >
        <ActorAvatar
          actorType={item.actor_type ?? item.recipient_type}
          actorId={item.actor_id ?? item.recipient_id}
          size={28}
          enableHoverCard
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {!read && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              )}
              <span
                className={`truncate text-sm ${!read ? "font-medium" : "text-muted-foreground"}`}
              >
                {displayTitle}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {merged && (
                <button
                  type="button"
                  aria-label={t(($) => expanded ? $.autopilot.collapse_runs : $.autopilot.expand_runs)}
                  title={t(($) => expanded ? $.autopilot.collapse_runs : $.autopilot.expand_runs)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpanded((value) => !value);
                  }}
                  className="inline-flex rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {expanded
                    ? <ChevronDown className="h-3.5 w-3.5" />
                    : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              )}
              <button
                type="button"
                title={t(($) => $.list.archive_tooltip)}
                onClick={(event) => {
                  event.stopPropagation();
                  onArchive();
                }}
                className="hidden rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:inline-flex"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
              {item.issue_status && (
                <StatusIcon status={item.issue_status} className="h-3.5 w-3.5 shrink-0" />
              )}
            </div>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs ${read ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
              <InboxDetailLabel item={item} />
            </p>
            <span className={`shrink-0 text-xs ${read ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
              {timeAgo(item.created_at)}
            </span>
          </div>
        </div>
      </div>
      {merged && expanded && (
        <div className="border-y bg-muted/20 py-1 pl-12 pr-4">
          {groupedItems.map((run) => (
            <div
              key={run.id}
              role="button"
              tabIndex={0}
              onClick={() => onItemClick?.(run)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onItemClick?.(run);
                }
              }}
              className="cursor-pointer border-l px-3 py-2 hover:bg-accent/50"
            >
              <div className="flex items-center justify-between gap-3">
                <span className={`min-w-0 truncate text-xs ${run.read ? "text-muted-foreground" : "font-medium"}`}>
                  {getInboxDisplayTitle(run, localizer)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(run.created_at)}
                </span>
              </div>
              <p className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                <InboxDetailLabel item={run} />
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
