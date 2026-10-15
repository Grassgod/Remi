"use client";

import { useMemo } from "react";
import type { TraceItem, TraceSubagentItem } from "@multiremi/contracts/trace";
import { subagentToolCount } from "@multiremi/shared/turn-trace";
import { useChatStore } from "@multiremi/core/chat";
import { cn } from "@multiremi/ui/lib/utils";
import { Bot, Check, ChevronRight, LoaderCircle, Square, X } from "lucide-react";
import { formatElapsedMs } from "../../common/format";
import { useT } from "../../i18n";
import {
  subagentDurationMs,
  subagentLabel,
  subagentPath,
  subagentStatus,
  subagentTaskLine,
} from "../lib/subagents";
import { SUBAGENT_SPIN, useSubagentTraceSource, type SubagentTraceSource } from "./subagent-context";
import { useTickingNow } from "./turn-steps-fold";

// A spawned subagent in a steps list (PR 5 §6.2): one step-height row,
// `[Bot] {name} · {task line}` with its status on the right. The whole row
// opens the subagent panel. It never shows live activity: the running strip
// and the panel do.

export const formatSubagentElapsed = (ms: number) => formatElapsedMs(ms, { rounding: "floor", hours: true });

/** Elapsed time: ticking once a second while the subagent runs, its duration once it ends. */
export function useSubagentElapsed(item: TraceSubagentItem): number | null {
  const running = item.status === "in_progress";
  const parsed = Date.parse(item.started_at);
  const start = Number.isFinite(parsed) ? parsed : null;
  const now = useTickingNow(running && start !== null, start);
  if (running) return start === null ? null : Math.max(0, now - start);
  return subagentDurationMs(item);
}

/** The status on the right of a subagent row: plain text like other step copy. */
export function SubagentStatusText({ item, items, className }: { item: TraceSubagentItem; items: readonly TraceItem[]; className?: string }) {
  const { t } = useT("chat");
  const status = subagentStatus(item);
  const elapsed = useSubagentElapsed(item);
  const time = elapsed != null ? formatSubagentElapsed(elapsed) : null;
  const tools = useMemo(() => subagentToolCount(items, item.id), [items, item.id]);
  const base = cn("flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums", className);
  switch (status) {
    case "running":
    case "background":
      return (
        <span data-subagent-status-text={status}
          className={cn(base, status === "background" ? "text-violet-700 dark:text-violet-300" : "text-brand")}>
          <LoaderCircle className={cn("size-3", SUBAGENT_SPIN)} aria-hidden="true" />
          {status === "background"
            ? t(($) => $.subagents.row_background, { elapsed: time ?? "" })
            : t(($) => $.subagents.row_running, { elapsed: time ?? "" })}
        </span>
      );
    case "completed":
      return (
        <span data-subagent-status-text={status} className={cn(base, "text-muted-foreground")}>
          <Check className="size-3" aria-hidden="true" />
          {tools > 0 ? t(($) => $.subagents.row_tools, { count: tools }) : t(($) => $.subagents.row_done)}
          {time && ` · ${time}`}
        </span>
      );
    case "failed":
      return (
        <span data-subagent-status-text={status} className={cn(base, "text-destructive")}>
          <X className="size-3" aria-hidden="true" />{t(($) => $.subagents.row_failed)}
        </span>
      );
    case "stopped":
      return (
        <span data-subagent-status-text={status} className={cn(base, "text-muted-foreground")}>
          <Square className="size-2.5 fill-current" aria-hidden="true" />{t(($) => $.subagents.row_stopped)}
        </span>
      );
  }
}

const ROW = "group/subagent flex w-full min-w-0 scroll-mt-16 items-center gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:text-muted-foreground";

function SubagentRowView({ item, items, highlighted = false, onOpen }: {
  item: TraceSubagentItem;
  items: readonly TraceItem[];
  highlighted?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useT("chat");
  const { name } = subagentLabel(item);
  const task = subagentTaskLine(item);
  return (
    <button
      type="button"
      data-subagent-row={item.id}
      data-subagent-status={subagentStatus(item)}
      data-highlighted={highlighted || undefined}
      aria-label={t(($) => $.subagents.open, { name })}
      disabled={!onOpen}
      onClick={onOpen}
      className={cn(ROW, highlighted && "text-foreground")}
    >
      <Bot className={cn("size-4 shrink-0", highlighted && "text-brand")} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={task ? `${name} · ${task}` : name}>
        <span className={cn("text-foreground/80 group-hover/subagent:text-foreground", highlighted && "text-foreground")}>{name}</span>
        {task && <span aria-hidden="true"> · {task}</span>}
      </span>
      <SubagentStatusText item={item} items={items} />
      {onOpen && (
        <ChevronRight className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover/subagent:opacity-100" aria-hidden="true" />
      )}
    </button>
  );
}

function OpenableSubagentRow({ item, items, source }: { item: TraceSubagentItem; items: readonly TraceItem[]; source: SubagentTraceSource & { attemptId: string } }) {
  const panel = useChatStore((s) => s.subagentPanel);
  const open = useChatStore((s) => s.openSubagentPanel);
  // Highlighted while the panel shows this subagent or one of its descendants.
  const highlighted = !!panel && panel.attemptId === source.attemptId && panel.path.includes(item.id);
  return (
    <SubagentRowView item={item} items={items} highlighted={highlighted} onOpen={() => open({
      sessionId: source.sessionId, attemptId: source.attemptId, turnId: source.turnId, live: source.live,
      path: subagentPath(items, item.id),
    })} />
  );
}

/** A subagent in a steps list; opens the panel when the list knows its attempt. */
export function SubagentStepRow({ item, items }: { item: TraceSubagentItem; items: readonly TraceItem[] }) {
  const source = useSubagentTraceSource();
  const attemptId = source.attemptId;
  return attemptId
    ? <OpenableSubagentRow item={item} items={items} source={{ ...source, attemptId }} />
    : <SubagentRowView item={item} items={items} />;
}

/** The live fold opens in 300ms; the row's final position is known after that. */
const FOLD_OPEN_MS = 320;

/**
 * Scroll the live fold to a top-level subagent's row, once the fold has
 * finished opening; retries briefly while the row is not laid out yet.
 */
export function scrollToSubagentRow(itemId: string): () => void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    const row = document.querySelector<HTMLElement>(`[data-chat-live-turn] [data-subagent-row="${CSS.escape(itemId)}"]`);
    if (row && row.getBoundingClientRect().height > 0) {
      // One jump, not a glide: a single scroll that leaves the bottom releases
      // the list's stick-to-bottom, which a smooth scroll can lose to it.
      row.scrollIntoView?.({ block: "center", behavior: "auto" });
      return;
    }
    if (++tries < 12) timer = setTimeout(attempt, 60);
  };
  timer = setTimeout(attempt, FOLD_OPEN_MS);
  return () => clearTimeout(timer);
}
