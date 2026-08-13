"use client";

import type { Issue } from "@multiremi/core/types";
import { StatusIcon } from "../../issues/components";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";

// Localized relative-time formatter, same shape as the inbox one but bound to
// the workbench namespace so this view stays self-contained.
export function useTimeAgo() {
  const { t } = useT("workbench");
  return (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t(($) => $.time.just_now);
    if (minutes < 60) return t(($) => $.time.minutes, { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t(($) => $.time.hours, { count: hours });
    const days = Math.floor(hours / 24);
    return t(($) => $.time.days, { count: days });
  };
}

export function WorkbenchListItem({
  issue,
  isSelected,
  urgent,
  onClick,
}: {
  issue: Issue;
  isSelected: boolean;
  /** Attention marker for issues where an agent is blocked waiting on a human. */
  urgent?: boolean;
  onClick: () => void;
}) {
  const timeAgo = useTimeAgo();

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      <StatusIcon status={issue.status} className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {urgent && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
          )}
          <span className="truncate text-sm">{issue.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground/70">
            {issue.identifier}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground/60">
            {timeAgo(issue.updated_at)}
          </span>
        </div>
      </div>
      {issue.assignee_type && issue.assignee_id && (
        <ActorAvatar
          actorType={issue.assignee_type}
          actorId={issue.assignee_id}
          size={20}
        />
      )}
    </button>
  );
}
