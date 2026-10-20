"use client";

import { useMemo } from "react";
import type { TraceItem } from "@multiremi/contracts/trace";
import { useChatStore } from "@multiremi/core/chat";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { Button } from "@multiremi/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { cn } from "@multiremi/ui/lib/utils";
import { PanelRight } from "lucide-react";
import { useTurnTrace } from "../../common/task-transcript/use-task-trace";
import { useT } from "../../i18n";
import {
  chatSubagentTurns,
  defaultPanelTarget,
  logHasBackgroundTasks,
  runningSubagentCount,
  type ChatPanelRecord,
} from "../lib/side-panel-record";
import { sidePanelId } from "./subagent-panel";
import { useCachedBackgroundTasks } from "./use-background-tasks";

// The persistent way back to a chat's side panel (子代理 / 后台任务), after
// Codex's header side-panel toggle and Claude's 「Background tasks」 menu: a
// header button shown while the chat has any subagent or background task on
// record, running or finished, so the panel can be reopened after the turn
// ended. Its badge counts what runs now.

/**
 * What the page has on record for the side panel, from what it already holds
 * (no read of its own, MUL-472): the loaded log window's turn cards and
 * doorbell rows, the running turn's live trace, the session list's running
 * background-task count and the registry cache.
 */
export function useChatPanelRecord({ sessionId, entries, live, backgroundTasksRunning }: {
  sessionId: string | null;
  entries: readonly SessionLogEntry[];
  /** The running turn and its live trace, when the page follows one. */
  live: { attemptId: string; turnId?: string; items: readonly TraceItem[] } | null;
  /** Running background tasks: the session list's count or the registry's, whichever is higher. */
  backgroundTasksRunning: number;
}): { record: ChatPanelRecord; running: number } {
  const items = live?.items;
  const liveHasSubagents = useMemo(() => !!items?.some((item) => item.type === "subagent"), [items]);
  const liveStartedAt = useMemo(() => items?.find((item) => item.parent_id === null)?.started_at ?? null, [items]);
  const runningSubagents = useMemo(() => items ? runningSubagentCount(items) : 0, [items]);
  const attemptId = live?.attemptId;
  const turnId = live?.turnId;
  const turns = useMemo(() => chatSubagentTurns(entries,
    attemptId ? { attemptId, turnId, hasSubagents: liveHasSubagents, startedAt: liveStartedAt } : null),
  [entries, attemptId, turnId, liveHasSubagents, liveStartedAt]);
  const cachedTasks = useCachedBackgroundTasks(sessionId);
  const logTasks = useMemo(() => logHasBackgroundTasks(entries), [entries]);
  const tasks = backgroundTasksRunning > 0 || cachedTasks.length > 0 || logTasks;
  const record = useMemo<ChatPanelRecord>(() => ({ turns, tasks }), [turns, tasks]);
  return { record, running: runningSubagents + backgroundTasksRunning };
}

/**
 * 「查看子代理与后台任务」 in the Chat page header and the floating window's:
 * opens the panel on the chat-wide 子代理 overview (or the 后台任务 view when
 * the chat only has tasks) and closes it again. Hidden for a chat with
 * neither on record.
 */
export function ChatSidePanelToggle({ sessionId, record, running, presentation, className }: {
  sessionId: string | null;
  record: ChatPanelRecord;
  running: number;
  presentation: "page" | "window";
  className?: string;
}) {
  const { t } = useT("chat");
  const panel = useChatStore((s) => s.subagentPanel);
  const openPanel = useChatStore((s) => s.openSubagentPanel);
  const closePanel = useChatStore((s) => s.closeSubagentPanel);
  // Keeps the newest group's trace in the cache while the chat is shown, so
  // reopening paints it at once; a disabled observer never reads.
  const newest = record.turns[0];
  useTurnTrace(newest?.attemptId, { enabled: false, turnId: newest?.turnId });
  if (!sessionId || (!record.turns.length && !record.tasks)) return null;
  const expanded = panel?.sessionId === sessionId;
  const panelId = sidePanelId(presentation);
  const label = t(($) => $.subagents.panel_toggle);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-side-panel-toggle={panelId}
            aria-label={running > 0 ? t(($) => $.subagents.panel_toggle_running, { count: running }) : label}
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            className={cn("relative shrink-0 text-muted-foreground", expanded && "bg-foreground/[0.06] text-foreground", className)}
            onClick={() => {
              if (expanded) closePanel();
              else openPanel(defaultPanelTarget(sessionId, record));
            }}
          />
        }
      >
        <PanelRight />
        {running > 0 && (
          <span aria-hidden="true" data-side-panel-badge=""
            className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] leading-none font-medium tabular-nums text-brand-foreground ring-2 ring-background">
            {running > 99 ? "99+" : running}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
