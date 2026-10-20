"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api } from "@multiremi/core/api";
import { useChatStore, type BackgroundTaskRef } from "@multiremi/core/chat";
import { backgroundStopErrorCode, type BackgroundStopErrorCode } from "@multiremi/core/chat/background-tasks";
import { useStopChatBackgroundTasks } from "@multiremi/core/chat/mutations";
import type { ChatBackgroundStopTarget } from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { confirmsBackgroundStop } from "@multiremi/shared/background-tasks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { cn } from "@multiremi/ui/lib/utils";
import {
  Activity,
  AlertCircle,
  Check,
  CircleHelp,
  Copy,
  LoaderCircle,
  Pause,
  ScrollText,
  Square,
  SquareTerminal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { TRACE_DETAIL_MONO } from "../../common/task-transcript/trace-item-detail";
import { useT } from "../../i18n";
import {
  backgroundKeptUntil,
  backgroundOutputLines,
  backgroundStopReasonKey,
  backgroundStopState,
  backgroundTaskDurationMs,
  backgroundTaskName,
  backgroundTaskStartedAt,
  backgroundTaskTypeKey,
  canStopBackgroundTask,
  formatBackgroundClock,
  formatKeepAliveCap,
  isLiveBackgroundTask,
  lastBackgroundOutputLine,
  splitBackgroundTasks,
  stoppableBackgroundTasks,
  type BackgroundTask,
} from "../lib/background-tasks";
import { useTickingNow } from "./live-hooks";
import { SUBAGENT_SPIN } from "./subagent-context";
import { formatSubagentElapsed } from "./subagent-step-row";

// The 后台任务 view of the right panel (PR 6 §8.2): a session-scoped list of
// the chat's background tasks from the registry, opened with or without a
// running turn, and a read-only detail per task. ■ on a running row, 停止 in
// the detail and 「全部停止」 stop tasks; per U3 only 「全部停止」 of two or more
// asks first. A stop reads 「正在停止…」 until the registry changes, and after
// 15 s 「停止请求已发送，等待电脑响应」.

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const MONO = TRACE_DETAIL_MONO;

const TYPE_ICONS: Record<string, LucideIcon> = { shell: SquareTerminal, workflow: Workflow };

export function BackgroundTaskIcon({ taskType, className }: { taskType: string; className?: string }) {
  const Icon = TYPE_ICONS[taskType] ?? Activity;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

/** The muted type label: 命令 / 工作流 / 监视; nothing for a type without one. */
export function useBackgroundTaskType(taskType: string): string | null {
  const { t } = useT("chat");
  const key = backgroundTaskTypeKey(taskType);
  return key ? t(($) => $.bg_tasks[key]) : null;
}

/** The UI locale for dates and units; a test double of `useT` may have no `i18n`. */
export function localeOf(i18n: { resolvedLanguage?: string; language?: string } | undefined): string {
  return i18n?.resolvedLanguage ?? i18n?.language ?? "en";
}

/** Elapsed time, formatted like a subagent's. */
const elapsed = (ms: number) => formatSubagentElapsed(Math.max(0, ms));

/** The status on the right of a row and in the detail header. */
export function BackgroundTaskStatus({ row, now, className }: { row: BackgroundTask; now: number; className?: string }) {
  const { t } = useT("chat");
  const base = cn("flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums", className);
  const stop = backgroundStopState(row, now);
  if (stop === "stopping" || stop === "sent") {
    return (
      <span data-bg-task-status-text="stopping" className={cn(base, "text-muted-foreground")}>
        <LoaderCircle className={cn("size-3", SUBAGENT_SPIN)} aria-hidden="true" />
        {stop === "sent" ? t(($) => $.bg_tasks.stop_sent) : t(($) => $.bg_tasks.stopping)}
      </span>
    );
  }
  const duration = backgroundTaskDurationMs(row);
  switch (row.status) {
    case "running": {
      const start = backgroundTaskStartedAt(row);
      return (
        <span data-bg-task-status-text="running" className={cn(base, "text-brand")}>
          <LoaderCircle className={cn("size-3", SUBAGENT_SPIN)} aria-hidden="true" />
          {t(($) => $.bg_tasks.running, { elapsed: start === null ? "" : elapsed(now - start) })}
        </span>
      );
    }
    case "paused":
      return <span data-bg-task-status-text="paused" className={cn(base, "text-muted-foreground")}><Pause className="size-3" aria-hidden="true" />{t(($) => $.bg_tasks.paused)}</span>;
    case "completed":
      return (
        <span data-bg-task-status-text="completed" className={cn(base, "text-muted-foreground")}>
          <Check className="size-3" aria-hidden="true" />
          {duration === null ? t(($) => $.subagents.row_done) : t(($) => $.bg_tasks.done, { duration: elapsed(duration) })}
        </span>
      );
    case "failed":
      return (
        <span data-bg-task-status-text="failed" className={cn(base, "text-destructive")}>
          <X className="size-3" aria-hidden="true" />
          {duration === null ? t(($) => $.subagents.row_failed) : t(($) => $.bg_tasks.failed, { duration: elapsed(duration) })}
        </span>
      );
    case "stopped":
      return <span data-bg-task-status-text="stopped" className={cn(base, "text-muted-foreground")}><Square className="size-2.5 fill-current" aria-hidden="true" />{t(($) => $.bg_tasks.stopped)}</span>;
    default:
      return <span data-bg-task-status-text="unknown" className={cn(base, "text-amber-700 dark:text-amber-300")}><CircleHelp className="size-3" aria-hidden="true" />{t(($) => $.bg_tasks.unknown)}</span>;
  }
}

/** Why a task ended, in words; null for an end that needs none. */
export function useBackgroundEndReason(): (row: BackgroundTask) => string | null {
  const { t, i18n } = useT("chat");
  const locale = localeOf(i18n);
  return (row) => {
    const key = backgroundStopReasonKey(row);
    if (!key) return null;
    return key === "stopped_keepalive_cap"
      ? t(($) => $.bg_tasks.stopped_keepalive_cap, { cap: formatKeepAliveCap(locale) })
      : t(($) => $.bg_tasks[key]);
  };
}

function stopErrorText(t: TFunction<"chat">, code: BackgroundStopErrorCode): string {
  return code === "task_not_running" ? t(($) => $.bg_tasks.err_ended)
    : code === "runtime_offline" ? t(($) => $.bg_tasks.err_offline) : t(($) => $.bg_tasks.err_failed);
}

/**
 * Stops tasks of one chat and remembers the last refusal per target, so the
 * row (or 「全部停止」) can say why. A new request clears it.
 */
export function useBackgroundStop(sessionId: string | null) {
  const mutation = useStopChatBackgroundTasks(sessionId);
  const [failure, setFailure] = useState<{ key: string; code: BackgroundStopErrorCode } | null>(null);
  return {
    stop: (target: ChatBackgroundStopTarget) => {
      const key = "all" in target ? "*" : target.task_id;
      setFailure(null);
      mutation.mutate(target, { onError: (error) => setFailure({ key, code: backgroundStopErrorCode(error) }) });
    },
    /** The refusal for one task (`task_id`), or for 「全部停止」 with `"*"`. */
    failureFor: (key: string) => failure?.key === key ? failure.code : null,
    pending: mutation.isPending,
  };
}

// ── Overview ────────────────────────────────────────────────────────────────

/**
 * The 后台任务 overview: 「后台保留到 {{time}}」 and 「全部停止」 on top, then
 * 运行中 · n and 已结束 · n. `currentAttemptId` is the running turn's attempt:
 * a task from any other turn says which one started it, when the registry
 * knows its number.
 */
export function BackgroundTasksOverview({ sessionId, rows, currentAttemptId, onOpen }: {
  sessionId: string | null;
  rows: readonly BackgroundTask[];
  currentAttemptId?: string | null;
  onOpen: (row: BackgroundTask) => void;
}) {
  const { t, i18n } = useT("chat");
  const locale = localeOf(i18n);
  const { running, done } = useMemo(() => splitBackgroundTasks(rows), [rows]);
  const live = running.some(isLiveBackgroundTask);
  const now = useTickingNow(live, null);
  const stopper = useBackgroundStop(sessionId);
  const [confirming, setConfirming] = useState(false);
  const stoppable = stoppableBackgroundTasks(rows, now);
  const keptUntil = backgroundKeptUntil(rows);
  const stopAll = () => {
    setConfirming(false);
    stopper.stop({ all: true });
  };
  const allFailure = stopper.failureFor("*");
  if (!rows.length) return <div data-bg-overview="empty" className="px-4 py-5 text-sm text-muted-foreground">{t(($) => $.bg_tasks.panel_empty)}</div>;
  return (
    <div data-bg-overview className="flex min-h-0 flex-col">
      {live && (
        <div data-bg-overview-toolbar className="flex min-h-10 items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" data-bg-kept-until>
            {keptUntil !== null ? t(($) => $.bg_tasks.kept_until, { time: formatBackgroundClock(keptUntil, locale, now) }) : null}
          </span>
          <Button size="xs" variant="outline" data-bg-stop-all disabled={!stoppable.length || stopper.pending}
            onClick={() => { if (confirmsBackgroundStop({ all: true, count: stoppable.length })) setConfirming(true); else stopAll(); }}>
            <Square className="size-2.5 fill-current" aria-hidden="true" />{t(($) => $.bg_tasks.stop_all)}
          </Button>
        </div>
      )}
      {allFailure && (
        <div role="alert" data-bg-stop-error="*" className="flex items-center gap-1.5 px-4 pt-3 text-xs text-destructive">
          <AlertCircle className="size-3.5" aria-hidden="true" />{stopErrorText(t, allFailure)}
        </div>
      )}
      <div className="px-3 py-5">
        {running.length > 0 && (
          <OverviewSection section="running" title={t(($) => $.bg_tasks.panel_running, { count: running.length })}>
            {running.map((row) => <BackgroundTaskRow key={row.id} row={row} now={now} currentAttemptId={currentAttemptId}
              failure={stopper.failureFor(row.task_id)} stopDisabled={stopper.pending}
              onOpen={() => onOpen(row)} onStop={() => stopper.stop({ task_id: row.task_id })} />)}
          </OverviewSection>
        )}
        {done.length > 0 && (
          <OverviewSection section="done" title={t(($) => $.bg_tasks.panel_done, { count: done.length })} className={running.length > 0 ? "mt-6" : undefined}>
            {done.map((row) => <BackgroundTaskRow key={row.id} row={row} now={now} currentAttemptId={currentAttemptId}
              failure={null} onOpen={() => onOpen(row)} />)}
          </OverviewSection>
        )}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-bg-stop-all-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.bg_tasks.confirm_stop_all, { count: stoppable.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.bg_tasks.confirm_stop_all_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t(($) => $.bg_tasks.confirm_cancel)}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" data-bg-stop-all-confirmed onClick={stopAll}>{t(($) => $.bg_tasks.stop_all)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OverviewSection({ section, title, className, children }: { section: "running" | "done"; title: string; className?: string; children: ReactNode }) {
  return (
    <section data-bg-section={section} className={className}>
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** 「来自第 n 轮」 for a task another turn started, when the registry gave the turn's number. */
function originLabel(t: TFunction<"chat">, row: BackgroundTask, currentAttemptId?: string | null): string | null {
  return row.origin_turn_seq && row.origin_attempt_id !== currentAttemptId ? t(($) => $.bg_tasks.from_turn, { n: row.origin_turn_seq }) : null;
}

function BackgroundTaskRow({ row, now, currentAttemptId, failure, stopDisabled, onOpen, onStop }: {
  row: BackgroundTask;
  now: number;
  currentAttemptId?: string | null;
  failure: BackgroundStopErrorCode | null;
  stopDisabled?: boolean;
  onOpen: () => void;
  onStop?: () => void;
}) {
  const { t } = useT("chat");
  const name = backgroundTaskName(row);
  const type = useBackgroundTaskType(row.task_type);
  const endReason = useBackgroundEndReason();
  const live = isLiveBackgroundTask(row);
  const stop = backgroundStopState(row, now);
  const stoppable = !!onStop && canStopBackgroundTask(row, now);
  const error = failure ? stopErrorText(t, failure)
    : stop === "not_running" ? t(($) => $.bg_tasks.err_ended) : stop === "failed" ? t(($) => $.bg_tasks.err_failed) : null;
  const detail = live ? lastBackgroundOutputLine(row.output_tail)
    : endReason(row) ?? (row.status === "completed" || row.status === "failed" ? row.summary?.split("\n").find((line) => line.trim())?.trim() ?? null : null);
  const origin = originLabel(t, row, currentAttemptId);
  const second = [detail, origin].filter(Boolean).join(" · ");
  return (
    <div data-bg-task-row={row.id} data-bg-task-status={row.status}
      className="group/bgrow flex w-full min-w-0 items-start rounded-lg transition-colors hover:bg-foreground/[0.05] focus-within:bg-foreground/[0.05]">
      <button type="button" data-bg-task-open onClick={onOpen} aria-label={t(($) => $.bg_tasks.open, { name })}
        className="flex min-h-10 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-lg px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex w-full min-w-0 items-center gap-2 text-sm">
          <BackgroundTaskIcon taskType={row.task_type} className={cn("text-muted-foreground", row.status === "failed" && "text-destructive")} />
          <span className="min-w-0 flex-1 truncate" title={row.command ?? row.name}>
            <span className="text-foreground">{name}</span>
            {type && <span className="text-muted-foreground"> {type}</span>}
          </span>
          <BackgroundTaskStatus row={row} now={now} />
        </span>
        {(error || second) && (
          <span className={cn("w-full truncate pl-6 text-sm text-muted-foreground", error && "text-destructive")}
            data-bg-task-second={error ? "error" : "info"}>
            {error ?? second}
          </span>
        )}
      </button>
      {/* Ended rows keep the ■ column empty, so every status lines up. */}
      {!(onStop && live) && <span aria-hidden="true" className="mr-1 size-7 shrink-0" />}
      {onStop && live && (
        <button type="button" data-bg-task-stop={row.id} onClick={onStop} disabled={!stoppable || stopDisabled}
          aria-label={t(($) => $.bg_tasks.stop, { name })} title={t(($) => $.bg_tasks.stop, { name })}
          className={cn(ICON_BUTTON, "mt-1.5 mr-1 opacity-0 group-hover/bgrow:opacity-100 group-focus-within/bgrow:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            !stoppable && "invisible")}>
          <Square className="size-3 fill-current" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

/** The detail header: ← back, the name and type, the status, 停止 and ×. */
export function BackgroundTaskDetailHeader({ sessionId, row, back, close }: {
  sessionId: string | null;
  row: BackgroundTask;
  back: ReactNode;
  close: ReactNode;
}) {
  const { t } = useT("chat");
  const name = backgroundTaskName(row);
  const type = useBackgroundTaskType(row.task_type);
  const live = isLiveBackgroundTask(row);
  const now = useTickingNow(live, null);
  const stopper = useBackgroundStop(sessionId);
  const failure = stopper.failureFor(row.task_id);
  const stoppable = canStopBackgroundTask(row, now);
  return (
    <div data-bg-detail-header className="shrink-0 border-b">
      <div className="flex items-start gap-1.5 py-2 pr-2 pl-2">
        <div className="mt-0.5">{back}</div>
        <div className="min-w-0 flex-1 py-0.5">
          <h2 className="truncate text-sm font-medium text-foreground" title={row.command ?? row.name}>{name}</h2>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {type && <span data-bg-task-type className="min-w-0 truncate">{type}</span>}
            <BackgroundTaskStatus row={row} now={now} />
          </div>
        </div>
        {live && row.can_stop && (
          <Button size="xs" variant="outline" className="mt-1" data-bg-detail-stop disabled={!stoppable || stopper.pending}
            onClick={() => stopper.stop({ task_id: row.task_id })}>
            <Square className="size-2.5 fill-current" aria-hidden="true" />{t(($) => $.bg_tasks.stop_short)}
          </Button>
        )}
        <div className="mt-0.5">{close}</div>
      </div>
      {(failure || backgroundStopState(row, now) === "failed") && (
        <div role="alert" data-bg-stop-error={row.task_id} className="flex items-center gap-1.5 px-4 pb-2 text-xs text-destructive">
          <AlertCircle className="size-3.5" aria-hidden="true" />{stopErrorText(t, failure ?? "failed")}
        </div>
      )}
    </div>
  );
}

const COPY_FEEDBACK_MS = 1500;

function CopyButton({ text }: { text: string }) {
  const { t } = useT("chat");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? t(($) => $.bg_tasks.copied) : t(($) => $.bg_tasks.copy_command);
  return (
    <button type="button" data-bg-copy-command onClick={() => { void copyText(text).then((ok) => { if (ok) setCopied(true); }); }}
      aria-label={label} title={label} className={cn(ICON_BUTTON, "size-6")}>
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

function DetailSection({ title, action, children, name }: { title: string; action?: ReactNode; children: ReactNode; name: string }) {
  return (
    <section data-bg-detail-section={name} className="space-y-1.5">
      <div className="flex min-h-6 items-center gap-1">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The read-only detail: the command (with copy), the live output tail (last
 * 40 lines), the summary, then when it started, how long it ran, the turn that
 * started it and a workflow's usage.
 */
export function BackgroundTaskDetail({ row }: { row: BackgroundTask }) {
  const { t, i18n } = useT("chat");
  const locale = localeOf(i18n);
  const endReason = useBackgroundEndReason();
  const lines = useMemo(() => backgroundOutputLines(row.output_tail), [row.output_tail]);
  const start = backgroundTaskStartedAt(row);
  const duration = isLiveBackgroundTask(row) ? null : backgroundTaskDurationMs(row);
  const reason = endReason(row);
  const usage = row.usage;
  return (
    <div data-bg-detail={row.id} className="space-y-5 px-4 py-5">
      {reason && <p data-bg-detail-reason className="text-sm text-muted-foreground">{reason}</p>}
      {row.command?.trim() && (
        <DetailSection name="command" title={t(($) => $.bg_tasks.command)} action={<CopyButton text={row.command} />}>
          <pre className={cn(MONO, "max-h-36 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 whitespace-pre-wrap break-all text-foreground")}>{row.command}</pre>
        </DetailSection>
      )}
      <DetailSection name="output" title={t(($) => $.bg_tasks.output)}>
        {lines.length ? (
          <pre data-bg-output className={cn(MONO, "max-h-80 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 whitespace-pre-wrap break-words text-muted-foreground")}>
            {lines.join("\n")}
          </pre>
        ) : (
          <p data-bg-output="empty" className="text-sm text-muted-foreground">
            {row.output_unreadable ? t(($) => $.bg_tasks.output_unreadable) : t(($) => $.bg_tasks.no_output)}
          </p>
        )}
      </DetailSection>
      {row.summary?.trim() && (
        <DetailSection name="summary" title={t(($) => $.bg_tasks.summary)}>
          <p className="text-sm whitespace-pre-wrap text-foreground">{row.summary}</p>
        </DetailSection>
      )}
      <div data-bg-detail-meta className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {start !== null && <span>{t(($) => $.bg_tasks.started, { time: formatBackgroundClock(start, locale) })}</span>}
        {duration !== null && <span>{t(($) => $.bg_tasks.duration, { duration: elapsed(duration) })}</span>}
        {usage && (
          <span data-bg-usage>
            {t(($) => $.bg_tasks.usage_tokens, { count: usage.total_tokens })} · {t(($) => $.bg_tasks.usage_tools, { count: usage.tool_uses })}
          </span>
        )}
        {row.origin_attempt_id && <OriginTurnLink attemptId={row.origin_attempt_id} turnId={row.origin_turn_id} />}
      </div>
    </div>
  );
}

/** 「后台保留到 {{time}}；关闭会话或到时会停止。」 under a running task's detail. */
export function BackgroundTaskDetailFooter({ row }: { row: BackgroundTask }) {
  const { t, i18n } = useT("chat");
  const locale = localeOf(i18n);
  const until = isLiveBackgroundTask(row) && row.parked_until ? Date.parse(row.parked_until) : NaN;
  if (!Number.isFinite(until)) return null;
  return <>{t(($) => $.bg_tasks.footer, { time: formatBackgroundClock(until, locale) })}</>;
}

/**
 * 「查看启动它的那一轮」: the execution log of the attempt that started the
 * task, read only when clicked (MUL-472).
 */
function OriginTurnLink({ attemptId, turnId }: { attemptId: string; turnId: string | null }) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const { data: task, isFetching, isError, refetch } = useQuery({
    queryKey: ["task-detail", attemptId],
    enabled: open,
    queryFn: () => api.getTask(attemptId, turnId ?? undefined),
  });
  return (
    <>
      <button type="button" data-bg-open-origin disabled={isFetching}
        onClick={() => { setOpen(true); if (isError) void refetch(); }}
        className="inline-flex items-center gap-1 rounded underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        {isFetching ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <ScrollText className="size-3" aria-hidden="true" />}
        {t(($) => $.bg_tasks.open_origin)}
      </button>
      {open && task && <OriginTraceDialog task={task} onOpenChange={setOpen} />}
    </>
  );
}

/** Mounted only once opened: the agent's name is looked up then, not with the detail. */
function OriginTraceDialog({ task, onOpenChange }: { task: AgentTask; onOpenChange: (open: boolean) => void }) {
  const { getActorName } = useActorName({ enabled: true });
  return <TaskTraceDialog task={task} agentName={getActorName("agent", task.agent_id)} onOpenChange={onOpenChange} />;
}

/** Opens the 后台任务 view of a chat's panel, at a task's detail or the overview. */
export function useOpenBackgroundTasks(sessionId: string | null) {
  const panel = useChatStore((s) => s.subagentPanel);
  const openPanel = useChatStore((s) => s.openSubagentPanel);
  return (task: BackgroundTaskRef | null, attempt?: { attemptId: string | null; turnId?: string; live: boolean }) => {
    // Keep the attempt the panel had, so the switch can go back to its subagents.
    const keep = panel && panel.sessionId === sessionId ? panel : null;
    openPanel({
      sessionId,
      view: "tasks",
      attemptId: attempt?.attemptId ?? keep?.attemptId ?? null,
      turnId: attempt?.turnId ?? keep?.turnId,
      live: attempt?.live ?? keep?.live ?? false,
      path: [],
      task,
    });
  };
}
