"use client";

import { useEffect, useMemo, useState } from "react";
import type { TraceItem, TraceSubagentItem } from "@multiremi/contracts/trace";
import { useChatStore } from "@multiremi/core/chat";
import { Popover, PopoverContent, PopoverTrigger } from "@multiremi/ui/components/ui/popover";
import { cn } from "@multiremi/ui/lib/utils";
import { Bot, ChevronDown, LoaderCircle, X } from "lucide-react";
import { useT } from "../../i18n";
import {
  runningSubagents,
  runningTree,
  subagentLabel,
  subagentPath,
  subagentTaskLine,
} from "../lib/subagents";
import {
  backgroundEndedNotices,
  backgroundTaskName,
  backgroundTaskStartedAt,
  nextNoticeChange,
  runningBackgroundTasks,
  type BackgroundTask,
} from "../lib/background-tasks";
import { buildChildSteps, liveLabel, type LiveLabel } from "../lib/turn-steps";
import { BackgroundTaskIcon, useBackgroundEndReason, useOpenBackgroundTasks } from "./background-task-view";
import { useCachedBackgroundTasks } from "./use-background-tasks";
import { useStickyLabel, useTickingNow } from "./live-hooks";
import { SUBAGENT_SPIN, type SubagentTraceSource } from "./subagent-context";
import { formatSubagentElapsed } from "./subagent-step-row";
import { useStepCopy } from "./turn-step-list";

// 「N 个子代理运行中」, sticky at the top of the message list while a
// subagent of the running turn is in progress (PR 5 §6.5). The count opens
// the panel's overview; a chip (top-level agents) opens that agent's detail
// and reveals its row in the live fold; the ▾ / +N button opens the running
// tree with each agent's live activity. No stop button: neither bridge lets
// Remi steer a child session.
//
// Background tasks (PR 6 §8.1) join it, with or without a running turn:
// 「N 个后台任务运行中」, or 「N 个子代理、M 个后台任务运行中」 with both. A task
// chip (name · elapsed) opens the task's detail in the 后台任务 view; the
// strip itself still stops nothing. Under it, a task that ended in the last
// 10 minutes with no reply to explain it gets a dismissible line.

/**
 * What a running subagent is doing now, in one line: its own live label,
 * else (while it waits on a nested agent) the nested one's, else 「正在写报告」
 * while its report streams. Labels are held like the turn's.
 */
export function useSubagentActivity(item: TraceSubagentItem, items: readonly TraceItem[]): string | null {
  const { t } = useT("chat");
  const copy = useStepCopy();
  const running = item.status === "in_progress";
  const steps = useMemo(() => buildChildSteps(items, item.id), [items, item.id]);
  const label = useStickyLabel(running ? liveLabel(steps) : null);
  const nested = useMemo(() => label?.kind === "quiet"
    ? items.filter((child): child is TraceSubagentItem => child.type === "subagent" && child.parent_id === item.id && child.status === "in_progress").at(-1)
    : undefined, [items, item.id, label?.kind]);
  const nestedSteps = useMemo(() => nested ? buildChildSteps(items, nested.id) : null, [items, nested]);
  const nestedLabel = useStickyLabel(nestedSteps ? liveLabel(nestedSteps) : null);
  if (!running) return null;
  const plain = (current: LiveLabel | null, empty: boolean): string => {
    if (!current || empty) return t(($) => $.subagents.activity_starting);
    if (current.kind === "quiet") return t(($) => $.subagents.activity_writing);
    return copy.live(current);
  };
  const started = items.some((child) => child.parent_id === item.id);
  if (label?.kind !== "quiet") return plain(label, !started);
  if (!nested) return t(($) => $.subagents.activity_writing);
  const nestedStarted = items.some((child) => child.parent_id === nested.id);
  return t(($) => $.subagents.activity_nested, { name: subagentLabel(nested).name, activity: plain(nestedLabel, !nestedStarted) });
}

const CHIP = "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 whitespace-nowrap transition-colors hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-ring";
const BACKGROUND_TAG = "rounded bg-violet-500/10 px-1 text-[10px] leading-4 text-violet-700 dark:text-violet-300";

export function SubagentRunningStrip({ items, source }: { items: readonly TraceItem[]; source: SubagentTraceSource & { attemptId: string } }) {
  const running = useMemo(() => runningSubagents(items), [items]);
  if (running.top.length + running.nested.length === 0) return null;
  return <RunningStrip items={items} source={source} top={running.top} nested={running.nested} tasks={[]} />;
}

const NO_ITEMS: readonly TraceItem[] = [];

/**
 * The chat's running strip: the running turn's subagents (when `source` names
 * the live attempt) and the chat's running background tasks from the
 * registry cache, then the end notices. `doorbells` are the task ids the
 * loaded conversation already explains with a doorbell line.
 */
export function ChatRunningStrip({ sessionId, items = NO_ITEMS, source, doorbells }: {
  sessionId: string | null;
  items?: readonly TraceItem[];
  source: (SubagentTraceSource & { attemptId: string }) | null;
  doorbells: ReadonlySet<string>;
}) {
  const running = useMemo(() => source ? runningSubagents(items) : { top: [], nested: [] }, [items, source]);
  const rows = useCachedBackgroundTasks(sessionId);
  const tasks = useMemo(() => runningBackgroundTasks(rows), [rows]);
  const subagents = running.top.length + running.nested.length;
  const notices = <BackgroundEndedNotices sessionId={sessionId} rows={rows} doorbells={doorbells} />;
  return (
    // One sticky block, so the strip and the notices never slide over each other.
    <div data-chat-running-strip className="sticky top-0 z-20 -mx-4 bg-background px-4 empty:hidden">
      {(subagents > 0 || tasks.length > 0) && (
        <RunningStrip items={items} source={subagents > 0 ? source : null} top={running.top} nested={running.nested}
          tasks={tasks} sessionId={sessionId} sticky={false} />
      )}
      {notices}
    </div>
  );
}

function RunningStrip({ items, source, top, nested, tasks, sessionId = source?.sessionId ?? null, sticky = true }: {
  items: readonly TraceItem[];
  source: (SubagentTraceSource & { attemptId: string }) | null;
  top: TraceSubagentItem[];
  nested: TraceSubagentItem[];
  tasks: readonly BackgroundTask[];
  sessionId?: string | null;
  /** Its own sticky block; the chat's strip puts it in one shared with the notices. */
  sticky?: boolean;
}) {
  const { t } = useT("chat");
  const panel = useChatStore((s) => s.subagentPanel);
  const openPanel = useChatStore((s) => s.openSubagentPanel);
  const revealSubagent = useChatStore((s) => s.revealSubagent);
  const openTasks = useOpenBackgroundTasks(sessionId);
  const [treeOpen, setTreeOpen] = useState(false);
  const now = useTickingNow(true, null);
  const elapsed = (startedAt: number | null) => startedAt === null ? "" : formatSubagentElapsed(Math.max(0, now - startedAt));
  const open = (path: string[]) => {
    if (!source) return;
    openPanel({ sessionId: source.sessionId, attemptId: source.attemptId, turnId: source.turnId, live: source.live, path });
  };
  const attempt = source ? { attemptId: source.attemptId, turnId: source.turnId, live: source.live } : undefined;
  const openAgent = (item: TraceSubagentItem) => {
    if (!source) return;
    const path = subagentPath(items, item.id);
    if (path[0]) revealSubagent(source.attemptId, path[0]);
    open(path);
    setTreeOpen(false);
  };
  const here = source && panel?.attemptId === source.attemptId && (panel.view ?? "subagents") === "subagents" ? panel : null;
  const tasksHere = panel?.sessionId === sessionId && panel?.view === "tasks" ? panel : null;
  // Top-level agents count; nested ones only when no top-level one runs.
  const agents = source ? top.length || nested.length : 0;
  const label = agents && tasks.length ? t(($) => $.bg_tasks.strip_mixed, { subagents: agents, tasks: tasks.length })
    : agents ? t(($) => $.subagents.strip_running, { count: agents }) : t(($) => $.bg_tasks.strip_running, { count: tasks.length });
  const overviewSelected = agents ? here?.path.length === 0 : !!tasksHere && !tasksHere.task;
  return (
    <div data-subagent-strip className={cn("@container pt-2 pb-2", sticky && "sticky top-0 z-20 -mx-4 bg-background px-4")}>
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-xl border bg-background px-1.5 text-xs shadow-xs">
        <button type="button" data-strip-overview onClick={() => agents ? open([]) : openTasks(null, attempt)}
          className={cn(CHIP, "gap-1.5 px-1.5 font-medium text-foreground", overviewSelected && "bg-brand/10 text-brand hover:bg-brand/15")}>
          <LoaderCircle className={cn("size-3.5 shrink-0 text-brand", SUBAGENT_SPIN)} aria-hidden="true" />
          <span className="@max-sm:hidden">{label}</span>
          <span className="@sm:hidden">{t(($) => $.subagents.strip_running_short, { count: agents + tasks.length })}</span>
        </button>
        <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {source && top.map((item) => {
            const selected = here?.path[0] === item.id;
            const { name } = subagentLabel(item);
            return (
              <button key={item.id} type="button" data-strip-chip={item.id} onClick={() => openAgent(item)}
                title={subagentTaskLine(item) ?? name} aria-label={t(($) => $.subagents.open, { name })}
                className={cn(CHIP, "text-foreground/85 hover:text-foreground", selected && "bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand")}>
                <Bot className="size-3.5 opacity-70" aria-hidden="true" />
                <span className="max-w-40 truncate">{name}</span>
                <span className="tabular-nums text-muted-foreground">· {elapsed(Date.parse(item.started_at))}</span>
                {item.background === true && <span className={BACKGROUND_TAG}>{t(($) => $.subagents.strip_background)}</span>}
              </button>
            );
          })}
          {tasks.map((row) => {
            const selected = tasksHere?.task?.task_id === row.task_id;
            const name = backgroundTaskName(row);
            return (
              <button key={row.id} type="button" data-strip-task-chip={row.id}
                onClick={() => openTasks({ task_id: row.task_id, provider_session_id: row.provider_session_id }, attempt)}
                title={row.command ?? row.name} aria-label={t(($) => $.bg_tasks.open, { name })}
                className={cn(CHIP, "text-foreground/85 hover:text-foreground", selected && "bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand")}>
                <BackgroundTaskIcon taskType={row.task_type} className="size-3.5 opacity-70" />
                <span className="max-w-40 truncate">{name}</span>
                <span className="tabular-nums text-muted-foreground">· {row.status === "paused" ? t(($) => $.bg_tasks.paused) : elapsed(backgroundTaskStartedAt(row))}</span>
              </button>
            );
          })}
        </div>
        {source && agents > 0 && (
          <Popover open={treeOpen} onOpenChange={setTreeOpen}>
            <PopoverTrigger
              data-strip-more
              aria-label={t(($) => $.subagents.strip_more)}
              title={t(($) => $.subagents.strip_more)}
              className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-full border px-1.5 tabular-nums text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-foreground/[0.06]"
            >
              {nested.length > 0 && <span className="pl-0.5">+{nested.length}</span>}
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] gap-1 p-1.5" data-strip-tree>
              <div className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">{t(($) => $.subagents.strip_tree)}</div>
              <RunningTree items={items} now={now} onOpen={openAgent} />
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

/**
 * 「{{name}} 已停止：{{reason}} · 查看 · ×」 for a task Remi stopped, and the
 * doorbell's own words for one that ended between turns with no reply (Codex),
 * for 10 minutes after it ended. Stops the person made are not repeated.
 */
function BackgroundEndedNotices({ sessionId, rows, doorbells }: {
  sessionId: string | null;
  rows: readonly BackgroundTask[];
  doorbells: ReadonlySet<string>;
}) {
  const { t } = useT("chat");
  const dismissedIds = useChatStore((s) => s.dismissedBackgroundNotices);
  const dismiss = useChatStore((s) => s.dismissBackgroundNotice);
  const openTasks = useOpenBackgroundTasks(sessionId);
  const endReason = useBackgroundEndReason();
  const [now, setNow] = useState(() => Date.now());
  // Notices appear when a grace ends and leave after 10 minutes: wake for the next change.
  const due = nextNoticeChange(rows, now);
  useEffect(() => {
    if (due === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due]);
  useEffect(() => { setNow(Date.now()); }, [rows]);
  const dismissed = useMemo(() => new Set(dismissedIds), [dismissedIds]);
  const notices = useMemo(() => backgroundEndedNotices(rows, { now, doorbells, dismissed }), [rows, now, doorbells, dismissed]);
  if (!notices.length) return null;
  return (
    <div data-bg-ended-notices className="space-y-1 pb-2 first:pt-2">
      {notices.map((row) => {
        const name = backgroundTaskName(row);
        const text = row.status === "completed" ? t(($) => $.bg_tasks.doorbell_done, { name })
          : row.status === "failed" ? t(($) => $.bg_tasks.doorbell_failed, { name })
            : t(($) => $.bg_tasks.ended_notice, { name, reason: endReason(row) ?? t(($) => $.bg_tasks.stopped) });
        return (
          <div key={row.id} data-bg-ended-notice={row.id} role="status"
            className="flex min-h-8 items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-xs text-muted-foreground">
            <BackgroundTaskIcon taskType={row.task_type} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
            <button type="button" data-bg-ended-notice-open onClick={() => openTasks({ task_id: row.task_id, provider_session_id: row.provider_session_id })}
              className="shrink-0 rounded px-1 font-medium text-foreground/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              {t(($) => $.bg_tasks.view_details)}
            </button>
            <button type="button" data-bg-ended-notice-dismiss onClick={() => dismiss(row.id)} aria-label={t(($) => $.bg_tasks.dismiss)}
              title={t(($) => $.bg_tasks.dismiss)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RunningTree({ items, now, onOpen }: { items: readonly TraceItem[]; now: number; onOpen: (item: TraceSubagentItem) => void }) {
  const rows = useMemo(() => runningTree(items), [items]);
  return (
    <div className="flex max-h-80 flex-col overflow-y-auto">
      {rows.map(({ item, depth }) => <TreeRow key={item.id} item={item} items={items} depth={depth} now={now} onOpen={onOpen} />)}
    </div>
  );
}

function TreeRow({ item, items, depth, now, onOpen }: {
  item: TraceSubagentItem; items: readonly TraceItem[]; depth: number; now: number; onOpen: (item: TraceSubagentItem) => void;
}) {
  const { t } = useT("chat");
  const activity = useSubagentActivity(item, items);
  const { name } = subagentLabel(item);
  const task = subagentTaskLine(item);
  return (
    <button type="button" data-strip-tree-row={item.id} onClick={() => onOpen(item)}
      style={{ paddingLeft: 8 + depth * 16 }}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-ring">
      <span className="flex w-full min-w-0 items-center gap-1.5 text-sm">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{name}</span>
          {task && <span className="text-muted-foreground"> · {task}</span>}
        </span>
        {item.background === true && <span className={BACKGROUND_TAG}>{t(($) => $.subagents.strip_background)}</span>}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatSubagentElapsed(Math.max(0, now - Date.parse(item.started_at)))}</span>
      </span>
      {activity && <span data-strip-activity className="truncate pl-5.5 text-xs text-muted-foreground">{activity}</span>}
    </button>
  );
}
