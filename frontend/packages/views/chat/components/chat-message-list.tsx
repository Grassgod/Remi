"use client";

import { isMemberQuestionReminder, LinkedQuestion, linkedQuestionId, QuestionReplyReference } from "../../common/linked-question";
import { questionReplyText } from "../../common/question-answer";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useAfterFirstScreen } from "@multiremi/core/platform/use-after-first-screen";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { api, TRACE_LIVE_WINDOW_SIZE } from "@multiremi/core/api";
import { toast } from "sonner";
import { cn } from "@multiremi/ui/lib/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multiremi/ui/components/ui/collapsible";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multiremi/ui/components/ui/tooltip";
import { ChevronRight, ChevronDown, Brain, AlertCircle, AlertTriangle, CircleSlash, Copy, LoaderCircle, Check, RotateCcw, ScrollText } from "lucide-react";
import { AttachmentSchema } from "@multiremi/core/api/schemas";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionLogEntry, SessionReplicaPort } from "@multiremi/core/replica";
import { Markdown } from "@multiremi/views/common/markdown";
import { SessionLogList } from "../../common/session-log/session-log-list";
import { isInboxTurn, metadataRecord } from "../../common/session-log/event-summary";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { AttachmentList } from "../../issues/components/comment-card";
import type { AgentAvailability } from "@multiremi/core/agents";
import type { ChatMessage, ChatPendingTask, TaskFailureReason } from "@multiremi/core/types";
import type { ChatTimelineItem } from "@multiremi/core/chat";
import { failureReasonLabel } from "../../agents/components/tabs/task-failure";
import { toChatTimeline } from "../lib/chat-timeline";
import { TaskStatusPill } from "./task-status-pill";
import { useTaskTraceState } from "../../common/task-transcript/use-task-trace";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { formatElapsedMs } from "../../common/format";
import { splitTimeline, extractCopyText } from "../lib/copy-text";
import { useT } from "../../i18n";
import { clientIdOf, mergeOptimisticChatRows, type OptimisticChatRow } from "../lib/optimistic-log";

/** Bumped when Chat's row layout changes, so cached row heights from the old layout are misses. */
const CHAT_LAYOUT_VERSION = ":chat-layout-v2";
/** Codex reading column: 768px including 16px side padding. */
const CHAT_CONTENT_CLASS = "max-w-[768px] px-4 py-6";
/**
 * Message actions stay out of the way until the row is hovered or holds
 * keyboard focus; devices without hover always show them. Opacity, not
 * display, so the row keeps its height and the buttons stay tabbable.
 */
const REVEAL_ON_ROW = "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
const COPY_FEEDBACK_MS = 1500;

// ─── Public component ────────────────────────────────────────────────────

interface ChatMessageListProps {
  sessionId: string;
  visible?: boolean;
  replica: SessionReplicaPort;
  optimisticRows: readonly OptimisticChatRow[];
  pendingTask: ChatPendingTask | null | undefined;
  availability: AgentAvailability | undefined;
  hasOlderMessages?: boolean;
  isFetchingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  onRetrySend?: (clientId: string) => void;
  initialPositioned?: boolean;
}

export function ChatMessageList({
  sessionId,
  visible = true,
  replica,
  optimisticRows,
  pendingTask,
  availability,
  hasOlderMessages = false,
  isFetchingOlderMessages = false,
  onLoadOlderMessages,
  onRetrySend,
  initialPositioned = false,
}: ChatMessageListProps) {
  const { t } = useT("chat");
  const namesReady = useAfterFirstScreen();
  const { getActorName } = useActorName({ enabled: visible && namesReady });
  const { t: traceT } = useT("agents");
  const scrollRoot = useRef<HTMLElement | null>(null);
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);
  const previousAvailability = useRef(availability);
  useLayoutEffect(() => {
    if (previousAvailability.current === availability) return;
    previousAvailability.current = availability;
    const root = scrollRoot.current;
    if (root?.dataset.stickState === "pinned") root.scrollTop = root.scrollHeight;
  }, [availability]);
  const snapshot = useSyncExternalStore(
    useCallback(listener => replica.subscribe(sessionId, listener), [replica, sessionId]),
    useCallback(() => replica.getSnapshot(sessionId), [replica, sessionId]),
    useCallback(() => replica.getSnapshot(sessionId), [replica, sessionId]),
  );
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const root = scrollRoot.current;
    if (!anchor || !root) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-perf-item="message"]')]
      .find(item => item.dataset.perfKey === anchor.id);
    if (!row) return;
    root.scrollTop += row.getBoundingClientRect().top - anchor.top;
    prependAnchor.current = null;
  }, [snapshot.entries]);
  const loadOlder = useCallback(() => {
    const root = scrollRoot.current;
    if (root) {
      const top = root.getBoundingClientRect().top;
      const row = [...root.querySelectorAll<HTMLElement>('[data-perf-item="message"]')]
        .find(item => item.getBoundingClientRect().bottom > top);
      if (row?.dataset.perfKey) prependAnchor.current = { id: row.dataset.perfKey,
        top: row.getBoundingClientRect().top };
    }
    if (visible) onLoadOlderMessages?.();
  }, [onLoadOlderMessages, visible]);
  const transformEntries = useCallback((entries: readonly SessionLogEntry[]) =>
    mergeOptimisticChatRows(entries.filter(entry => {
      const row = entry as SessionLogEntry & { author_type?: string; sender_type?: string; message_kind?: string; deleted_at?: string | null; metadata?: Record<string, unknown>; to_type?: string | null };
      if (row.seq === 0 || row.deleted_at) return false;
      // A Chat Q's member reminders land in its own session, beside the original
      // Q row, so the Chat never repeats the question for any reader.
      if (isMemberQuestionReminder(row)) return false;
      if (row.kind === "message" && (row.message_kind || row.sender_type)) return true;
      if (metadataRecord(row.metadata).envelope) return false;
      if (row.kind === "message" && row.author_type === "system" && !row.sender_type) return false;
      return row.kind === "turn" ? !isInboxTurn(row.body_md) : row.kind === "message";
    }).map(entry => {
      // Q rows became one fixed-height summary line; never reserve the old button height.
      const row = entry as SessionLogEntry & { metadata?: Record<string, unknown> };
      const question = row.kind === "message" && linkedQuestionId(row.id, row.metadata) ? ":question-line-v1" : "";
      // The Chat column, bubble and turn rows changed size; old cached heights are misses.
      return { ...entry, render_version: `${entry.render_version ?? ""}${question}${CHAT_LAYOUT_VERSION}` };
    }), optimisticRows), [optimisticRows]);
  const entryKey = useCallback((entry: SessionLogEntry) => clientIdOf(entry) ?? entry.id, []);
  const pendingTaskId = pendingTask?.task_id ?? null;
  const pendingAlreadyPersisted = !!pendingTaskId && replica.getSnapshot(sessionId).entries.some((entry) => {
    const row = entry as SessionLogEntry & { task_id?: string; metadata?: Record<string, unknown> };
    return row.kind === "turn" && row.task_id === pendingTaskId
      && !isNonterminalTurn(row.metadata);
  });
  const showLiveTimeline = !!pendingTaskId && !pendingAlreadyPersisted;
  const liveTrace = useTaskTraceState(pendingTaskId, visible && showLiveTimeline, true, pendingTask?.turn_id);
  const liveTaskEvents = liveTrace.events;
  const liveTimeline: ChatTimelineItem[] = toChatTimeline(liveTaskEvents);
  const hasLive = showLiveTimeline && liveTimeline.length > 0;
  const showStatusPill = !!pendingTaskId && !pendingAlreadyPersisted && !!pendingTask && !liveTrace.closed && !liveTrace.error;

  return <SessionLogList sessionId={sessionId} replica={replica} perfScroll="session-log"
    contentClassName={CHAT_CONTENT_CLASS} scrollButton="arrow"
    onScrollRoot={element => { scrollRoot.current = element; }}
    initialPositioned={initialPositioned} showPendingSkeleton={false}
    localDataReady={optimisticRows.length > 0}
    transformEntries={transformEntries}
    entryKey={entryKey}
    header={<div className="flex h-10 items-center justify-center text-xs text-muted-foreground max-md:h-12">
      {hasOlderMessages ? <button type="button" data-chat-earlier disabled={!visible || isFetchingOlderMessages}
        onClick={loadOlder} className="h-full hover:text-foreground">
        {isFetchingOlderMessages ? t(($) => $.message_list.loading_older) : t(($) => $.message_list.expand_older)}
      </button> : t(($) => $.message_list.earliest)}
    </div>}
    renderEntry={({ entry }) => {
      const row = entry as SessionLogEntry & {
        author_type?: string; sender_type?: string; task_id?: string | null; created_at?: string;
        wake_applied?: SessionLogRow["wake_applied"]; wake_reason?: SessionLogRow["wake_reason"];
        metadata?: Record<string, unknown>;
      };
      const isUser = row.kind === "message" && (row.sender_type ?? row.author_type) === "member";
      const message: ChatMessage = {
        id: row.id, chat_session_id: sessionId, role: isUser ? "user" : "assistant",
        content: questionReplyText(isUser ? row.body_md : String(row.metadata?.final_reply_md ?? row.body_md), row.metadata),
        task_id: row.kind === "turn" ? row.task_id ?? null : null, turn_id: typeof row.metadata?.turn_id === "string" ? row.metadata.turn_id : undefined, created_at: row.created_at ?? "",
        failure_reason: typeof row.metadata?.failure_reason === "string" ? row.metadata.failure_reason : null,
          elapsed_ms: typeof row.metadata?.elapsed_ms === "number" ? row.metadata.elapsed_ms : null,
          attachments: AttachmentSchema.array().safeParse(row.metadata?.attachments).data as ChatMessage["attachments"],
      };
      const clientId = clientIdOf(entry);
      const local = optimisticRows.find((item) => item.clientId === clientId);
      const isPush = row.kind === "turn" && isNonterminalTurn(row.metadata);
      const questionId = row.kind === "message" ? linkedQuestionId(row.id, row.metadata) : null;
      const turnId = row.kind === "turn" && typeof row.metadata?.turn_id === "string" ? row.metadata.turn_id : null;
      const turnStatus = turnId && typeof row.metadata?.status === "string" ? row.metadata.status : null;
      return <div className="group/message">
        {questionId ? <LinkedQuestion id={questionId} getActorName={getActorName} /> : null}
        {turnId && (turnStatus === "failed" || turnStatus === "cancelled")
          ? <TurnEndNotice turnId={turnId} attemptId={row.task_id ?? null} status={turnStatus}
            failureReason={message.failure_reason ?? null} details={message.content} visible={visible} />
          : row.kind === "turn" && row.metadata?.final_entry_id
            // The reply is its own message row; the card keeps only the execution log.
            ? (row.task_id ? <div className="flex h-6 items-center"><ChatTraceButton taskId={row.task_id}
              turnId={turnId ?? undefined} visible={visible} quiet /></div> : null)
            : <MessageBubble message={message} isPending={!!pendingTaskId && row.task_id === pendingTaskId}
              isPush={isPush} visible={visible} />}
        {isUser && <NotWokenHint wakeApplied={row.wake_applied} wakeReason={row.wake_reason} />}
        {row.kind === "message" && !questionId && <QuestionReplyReference metadata={row.metadata} />}
        {isUser && local && <div className="flex justify-end"><SendStatus status={local.status}
          onRetry={() => onRetrySend?.(local.clientId)} /></div>}
      </div>;
    }}
    footer={<div className="space-y-4 pb-4">
      {hasLive && <div className="text-[10px] text-muted-foreground">{traceT(($) => $.transcript.trace_window, { count: TRACE_LIVE_WINDOW_SIZE })}</div>}
      {hasLive && <TimelineView items={liveTimeline} isStreaming={!liveTrace.closed && !liveTrace.error} />}
      {showLiveTimeline && liveTrace.error && <div role="alert" className="text-xs text-destructive">{traceT(($) => $.transcript.trace_failed)}</div>}
      {showStatusPill && pendingTask && <TaskStatusPill pendingTask={pendingTask}
        taskMessages={liveTaskEvents} availability={availability} />}
    </div>} />;
}

function isNonterminalTurn(metadata?: Record<string, unknown>): boolean {
  if (typeof metadata?.status === "string") return !["completed", "failed", "cancelled"].includes(metadata.status);
  return metadata?.elapsed_ms == null && metadata?.failure_reason == null;
}

function SendStatus({ status, onRetry }: { status: OptimisticChatRow["status"]; onRetry: () => void }) {
  const { t } = useT("chat");
  return <div aria-live="polite" className="flex h-5 items-center text-xs text-muted-foreground max-md:h-6"
    style={status === "hidden" ? { visibility: "hidden" } : undefined}>
    {status === "sending" && <><LoaderCircle className="mr-1 size-3 animate-spin" aria-hidden="true" />{t(($) => $.message_list.sending)}</>}
    {(status === "sent" || status === "hidden") && <><Check className="mr-1 size-3" aria-hidden="true" />{t(($) => $.message_list.sent)}</>}
    {status === "failed" && <><AlertCircle className="mr-1 size-3 text-destructive" aria-hidden="true" />
      <span className="text-destructive">{t(($) => $.message_list.send_failed)}</span>
      <button type="button" onClick={onRetry} aria-label={t(($) => $.message_list.retry_send)}
        className="relative inline-flex h-5 items-center justify-center px-1 text-destructive underline after:absolute after:-inset-y-3 after:inset-x-0">
        {t(($) => $.message_list.retry)}
      </button></>}
  </div>;
}

// ─── Message bubbles ─────────────────────────────────────────────────────

function MessageBubble({ message, isPending, isPush, visible }: { message: ChatMessage; isPending: boolean; isPush: boolean; visible: boolean }) {
  if (message.role === "user") {
    const markdown = message.content;
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] break-words rounded-[22px] bg-muted px-4 py-2.5 text-sm">
          {/* User messages are authored as markdown in ContentEditor, so
           * render them through the same pipeline as assistant replies.
           * Neutralise prose's leading/trailing margin so single-line
           * bubbles stay as compact as the plain-text version used to. */}
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <Markdown attachments={message.attachments}>{markdown}</Markdown>
          </div>
          <AttachmentList
            attachments={message.attachments}
            content={markdown}
            dedupe="url"
            className="mt-1.5"
          />
        </div>
      </div>
    );
  }

  return <AssistantMessage message={message} isPending={isPending} isPush={isPush} visible={visible} />;
}

function AssistantMessage({
  message,
  isPending,
  isPush,
  visible,
}: {
  message: ChatMessage;
  isPending: boolean;
  isPush: boolean;
  visible: boolean;
}) {
  const timeline: ChatTimelineItem[] = [];

  // Legacy failure bubble: an assistant row written by the server's FailTask
  // fallback before turns carried their own status. Canonical failed turns
  // render TurnEndNotice instead.
  if (message.failure_reason) {
    return (
      <div className="w-full space-y-1.5"><FailureBubble
        reason={message.failure_reason}
        rawError={message.content}
        timeline={timeline}
        elapsedMs={message.elapsed_ms}
      />
        {message.task_id && !isPush && <ChatTraceButton taskId={message.task_id} turnId={message.turn_id} visible={visible} />}
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
        <Markdown attachments={message.attachments}>{message.content}</Markdown>
      </div>
      <AttachmentList
        attachments={message.attachments}
        content={message.content}
        dedupe="url"
      />
      <MessageFooter
        message={message}
        timeline={timeline}
        isPending={isPending}
        trace={message.task_id && !isPush
          ? <ChatTraceButton taskId={message.task_id} turnId={message.turn_id} visible={visible} quiet /> : null}
      />
    </div>
  );
}

/**
 * Task detail and trace are requested only after the reader opens execution.
 * `quiet` hides the button until its row is hovered or focused; a pending
 * load or an error always stays visible.
 */
function ChatTraceButton({ taskId, turnId, visible, quiet = false }: { taskId: string; turnId?: string; visible: boolean; quiet?: boolean }) {
  const { t } = useT("agents");
  const { t: tc } = useT("chat");
  const [open, setOpen] = useState(false);
  const { getActorName } = useActorName({ enabled: visible && open });
  const { data: task, isFetching, isError, refetch } = useQuery({
    queryKey: ["task-detail", taskId],
    enabled: visible && open,
    queryFn: () => api.getTask(taskId, turnId),
  });
  return <>
    <button type="button" disabled={!visible || isFetching} onClick={() => {
      setOpen(true);
      if (isError) void refetch();
    }} data-chat-trace className={cn("inline-flex h-6 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
      quiet && !isFetching && !isError && REVEAL_ON_ROW)}>
      {isFetching ? <LoaderCircle className="size-3 animate-spin" /> : <ScrollText className="size-3" />}
      {isError ? t(($) => $.transcript.trace_retry) : tc(($) => $.message_list.view_execution_log)}
    </button>
    {open && visible && task && <TaskTraceDialog task={task} agentName={getActorName("agent", task.agent_id)} onOpenChange={setOpen} />}
    {isError && <span role="alert" className="text-xs text-destructive">{t(($) => $.transcript.trace_failed)}</span>}
  </>;
}

/**
 * A failed or cancelled turn: one notice line with the outcome, the retry
 * choices and the execution log. Retrying keeps the same turn and adds an
 * attempt, so the queries the old attempts list refreshed are refreshed here.
 */
function TurnEndNotice({ turnId, attemptId, status, failureReason, details, visible }: {
  turnId: string;
  attemptId: string | null;
  status: "failed" | "cancelled";
  failureReason: string | null;
  details: string;
  visible: boolean;
}) {
  const { t } = useT("chat");
  const { t: tm } = useT("messages");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const retry = useMutation({
    mutationFn: (cold: boolean) => api.retryTurn(turnId, cold),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["turns", wsId, turnId] });
      void qc.invalidateQueries({ queryKey: ["issues", wsId] });
      void qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["chat", wsId] });
      void qc.invalidateQueries({ queryKey: ["chat", "pending-task"] });
    },
  });
  const statuses = tm($ => $.statuses, { returnObjects: true }) as Record<string, string> | string;
  const statusLabel = (typeof statuses === "object" ? statuses[status] : undefined) || status;
  const reason = failureReason
    ? failureReasonLabel[failureReason as TaskFailureReason] ?? t(($) => $.message_list.task_failed_fallback)
    : null;
  // The server writes `Task failed` when a run reported nothing of its own.
  const rawError = details.trim() && details.trim() !== `Task ${status}` ? details.trim() : "";
  const failed = status === "failed";
  return (
    <div data-turn-notice={status} className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {failed
          ? <AlertTriangle className="size-3.5 shrink-0 text-destructive/80" aria-hidden="true" />
          : <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className={failed ? "text-destructive/90" : "text-muted-foreground"}>
          {statusLabel}{reason ? ` · ${reason}` : ""}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant="outline" data-turn-retry="warm" disabled={retry.isPending} onClick={() => retry.mutate(false)}>
            <RotateCcw className="size-3" />{t(($) => $.message_list.turn_retry)}
          </Button>
          <Button size="xs" variant="ghost" data-turn-retry="cold" disabled={retry.isPending} onClick={() => retry.mutate(true)}>
            {t(($) => $.message_list.turn_retry_new_session)}
          </Button>
          {attemptId && <ChatTraceButton taskId={attemptId} turnId={turnId} visible={visible} />}
        </span>
      </div>
      {rawError && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="ml-5 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span>{t(($) => $.message_list.show_details)}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 ml-5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-xs text-muted-foreground">
              {rawError}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      {retry.isError && <p role="alert" className="ml-5 text-xs text-destructive">{tm($ => $.retry_failed)}</p>}
    </div>
  );
}

/**
 * The envelope header is gone from Chat; the one fact worth a line is a
 * message that did not wake the agent (it waits for the next turn or the
 * inbox), explained with the server's wake reason.
 */
function NotWokenHint({ wakeApplied, wakeReason }: { wakeApplied?: string | null; wakeReason?: string | null }) {
  const { t } = useT("chat");
  const { t: tm } = useT("messages");
  if (!wakeApplied || wakeApplied === "now") return null;
  const reasons = tm($ => $.wake_reasons, { returnObjects: true }) as Record<string, string> | string;
  const wakes = tm($ => $.wakes, { returnObjects: true }) as Record<string, string> | string;
  const reason = (wakeReason && typeof reasons === "object" ? reasons[wakeReason] : undefined)
    || wakeReason || (typeof wakes === "object" ? wakes[wakeApplied] : undefined) || wakeApplied;
  return (
    <p data-wake-hint={wakeApplied} className="mt-1 truncate text-right text-xs text-muted-foreground" title={reason}>
      {t(($) => $.message_list.not_woken, { reason })}
    </p>
  );
}

// Inline footer row beneath the assistant reply: "Replied in 38s · [Copy] [Log]".
// The elapsed caption always shows; the actions appear on hover or keyboard
// focus (see REVEAL_ON_ROW). Copy is suppressed during streaming because the
// final text is still being appended.
function MessageFooter({
  message,
  timeline,
  isPending,
  trace,
}: {
  message: ChatMessage;
  timeline: ChatTimelineItem[];
  isPending: boolean;
  trace?: React.ReactNode;
}) {
  const showCopy = !isPending;
  if (message.elapsed_ms == null && !showCopy && !trace) return null;
  return (
    <div className="flex min-h-6 items-center gap-1.5">
      {message.elapsed_ms != null && (
        <ElapsedCaption variant="replied" elapsedMs={message.elapsed_ms} />
      )}
      {showCopy && <MessageCopyButton message={message} timeline={timeline} />}
      {trace}
    </div>
  );
}

function MessageCopyButton({
  message,
  timeline,
}: {
  message: ChatMessage;
  timeline: ChatTimelineItem[];
}) {
  const { t } = useT("chat");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const handleCopy = async () => {
    if (await copyText(extractCopyText(message, timeline))) {
      setCopied(true);
    } else {
      toast.error(t(($) => $.message_list.copy_failed_toast));
    }
  };
  const label = copied ? t(($) => $.session_log.copied) : t(($) => $.message_list.copy_action);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            data-chat-copy={copied ? "copied" : ""}
            className={cn("text-muted-foreground/70 hover:text-foreground", !copied && REVEAL_ON_ROW)}
            onClick={handleCopy}
            aria-label={label}
          />
        }
      >
        {copied ? <Check /> : <Copy />}
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// Persisted "Replied in 38s" / "Failed after 12s" line under the assistant
// bubble. Reads `elapsed_ms` straight off the chat_message — server computes
// it once at task completion, so this caption is identical across reloads
// and devices. Skipped silently when null (legacy messages predating
// migration 063 + user messages).
function ElapsedCaption({
  variant,
  elapsedMs,
  className,
}: {
  variant: "replied" | "failed";
  elapsedMs: number;
  className?: string;
}) {
  const { t } = useT("chat");
  const text =
    variant === "replied"
      ? t(($) => $.message_list.replied_in, { elapsed: formatElapsedMs(elapsedMs) })
      : t(($) => $.message_list.failed_after, { elapsed: formatElapsedMs(elapsedMs) });
  return (
    <div className={cn("text-xs text-muted-foreground/80", className)}>
      {text}
    </div>
  );
}

function FailureBubble({
  reason,
  rawError,
  timeline,
  elapsedMs,
}: {
  reason: string;
  rawError: string;
  timeline: ChatTimelineItem[];
  elapsedMs?: number | null;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  // Map the back-end enum to copy via the shared label table; an unknown
  // reason (e.g. a future enum value the front-end doesn't ship yet)
  // falls back to a generic translated label.
  const label =
    failureReasonLabel[reason as TaskFailureReason] ??
    t(($) => $.message_list.task_failed_fallback);

  return (
    <div className="w-full space-y-1.5">
      {/* Failure read as an inline, low-key note — not a destructive
       *  alert. Intentionally borderless / no background tint: a chat
       *  failure is informational ("this didn't work"), not a system
       *  error. The icon + muted destructive text are signal enough,
       *  the rest stays in the normal reply rhythm. */}
      <div className="flex items-start gap-1.5 text-sm">
        <AlertTriangle className="size-3.5 shrink-0 text-destructive/80 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-destructive/90">{label}</div>
          {rawError.trim() && (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                {open ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                <span>{t(($) => $.message_list.show_details)}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-all">
                  {rawError}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
      {timeline.length > 0 && <TimelineView items={timeline} />}
      {elapsedMs != null && (
        <ElapsedCaption variant="failed" elapsedMs={elapsedMs} />
      )}
    </div>
  );
}

// ─── Timeline: outer process fold + final text (Conductor-style) ─────────
//
// splitTimeline (lib/copy-text.ts) carves the items into:
//   preface — text before the first thinking/tool item
//   middle  — first → last non-text item (inclusive, may sandwich text)
//   final   — text after the last non-text item
//
// We render preface + final outside an outer Collapsible ("X steps") that
// wraps middle. The inner row Collapsibles (ThinkingRow / ToolCallRow /
// ToolResultRow) are unchanged — clicking them toggles independently of
// the outer fold. Copy mirrors what's visible when the outer fold is
// closed: preface + final, never middle. See extractCopyText for the
// authoritative copy logic.

function TimelineView({
  items,
  isStreaming,
  attachments,
}: {
  items: ChatTimelineItem[];
  isStreaming?: boolean;
  attachments?: import("@multiremi/core/types").Attachment[];
}) {
  const { preface, middle, final } = splitTimeline(items);

  return (
    <>
      {preface.length > 0 && (
        <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
          <Markdown attachments={attachments}>
            {preface.map((t) => t.content ?? "").join("")}
          </Markdown>
        </div>
      )}
      {middle.length > 0 && (
        <OuterProcessFold
          items={middle}
          defaultOpen={!!isStreaming}
          attachments={attachments}
        />
      )}
      {final.length > 0 && (
        <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
          <Markdown attachments={attachments}>
            {final.map((t) => t.content ?? "").join("")}
          </Markdown>
        </div>
      )}
    </>
  );
}

function OuterProcessFold({
  items,
  defaultOpen,
  attachments,
}: {
  items: ChatTimelineItem[];
  defaultOpen?: boolean;
  attachments?: import("@multiremi/core/types").Attachment[];
}) {
  const { t } = useT("chat");
  // useState seeds once at mount — subsequent renders never overwrite the
  // user's manual toggle. The streaming → completed transition unmounts
  // the live <TimelineView> and mounts the persisted AssistantMessage's
  // own <TimelineView>, so the persisted instance starts closed (default)
  // even if the live one was open. That's the desired collapsed-default.
  const [open, setOpen] = useState(defaultOpen ?? false);
  const stepCount = items.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>{t(($) => $.message_list.process_steps, { count: stepCount })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-lg border bg-muted/20 p-2 space-y-0.5">
          {items.map((item) =>
            item.type === "text" ? (
              <MiddleTextRow key={item.seq} item={item} attachments={attachments} />
            ) : (
              <ItemRow key={item.seq} item={item} />
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Intermediate text segment rendered inside the outer fold. Visually
// down-shifted (xs / muted) so it reads as part of the agent's process,
// not the final answer — the final answer renders below the fold at full
// prose size.
function MiddleTextRow({
  item,
  attachments,
}: {
  item: ChatTimelineItem;
  attachments?: import("@multiremi/core/types").Attachment[];
}) {
  return (
    <div className="py-0.5 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown attachments={attachments}>{item.content ?? ""}</Markdown>
    </div>
  );
}

// ─── Individual item rows ────────────────────────────────────────────────

function ItemRow({ item }: { item: ChatTimelineItem }) {
  switch (item.type) {
    case "tool_use":
      return <ToolCallRow item={item} />;
    case "tool_result":
      return <ToolResultRow item={item} />;
    case "thinking":
      return <ThinkingRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "permission_request":
    case "permission_response":
    case "question_request":
    case "question_response":
      return <HumanEventRow item={item} />;
    default:
      return null;
  }
}

// Static history rows for the approval-routing flow; the interactive pending
// card lives in HumanRequestDock, this only records what was asked/decided.
function HumanEventRow({ item }: { item: ChatTimelineItem }) {
  const isRequest = item.type === "permission_request" || item.type === "question_request";
  return (
    <div className="flex items-start gap-1.5 py-0.5 text-xs text-muted-foreground">
      <AlertCircle
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", isRequest ? "text-amber-500" : "text-emerald-500")}
      />
      <span className="min-w-0 break-words">{item.content ?? ""}</span>
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

function getToolSummary(item: ChatTimelineItem): string {
  if (!item.input) return "";
  const inp = item.input as Record<string, string>;
  if (inp.query) return inp.query;
  if (inp.file_path) return shortenPath(inp.file_path);
  if (inp.path) return shortenPath(inp.path);
  if (inp.pattern) return inp.pattern;
  if (inp.description) return String(inp.description);
  if (inp.command) {
    const cmd = String(inp.command);
    return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
  }
  if (inp.prompt) {
    const p = String(inp.prompt);
    return p.length > 100 ? p.slice(0, 100) + "..." : p;
  }
  if (inp.skill) return String(inp.skill);
  for (const v of Object.values(inp)) {
    if (typeof v === "string" && v.length > 0 && v.length < 120) return v;
  }
  return "";
}

function ToolCallRow({ item }: { item: ChatTimelineItem }) {
  const [open, setOpen] = useState(false);
  const summary = getToolSummary(item);
  const hasInput = item.input && Object.keys(item.input).length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !hasInput && "invisible",
          )}
        />
        <span className="font-medium text-foreground shrink-0">{item.tool}</span>
        {summary && <span className="truncate text-muted-foreground">{summary}</span>}
      </CollapsibleTrigger>
      {hasInput && (
        <CollapsibleContent>
          <pre className="ml-[18px] mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-all">
            {JSON.stringify(item.input, null, 2)}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function ToolResultRow({ item }: { item: ChatTimelineItem }) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const output = item.output ?? "";
  if (!output) return null;

  const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;
  const labelPrefix = item.tool
    ? t(($) => $.message_list.tool_result_named, { tool: item.tool })
    : t(($) => $.message_list.tool_result_unnamed);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform mt-0.5", open && "rotate-90")}
        />
        <span className="text-muted-foreground/70 truncate">
          {labelPrefix}{preview}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-all">
          {output.length > 4000 ? output.slice(0, 4000) + "\n... (truncated)" : output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThinkingRow({ item }: { item: ChatTimelineItem }) {
  const [open, setOpen] = useState(false);
  const text = item.content ?? "";
  if (!text) return null;

  const preview = text.length > 150 ? text.slice(0, 150) + "..." : text;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <Brain className="h-3 w-3 shrink-0 text-muted-foreground/60 mt-0.5" />
        <span className="text-muted-foreground italic truncate">{preview}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-muted/30 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ErrorRow({ item }: { item: ChatTimelineItem }) {
  return (
    <div className="flex items-start gap-1.5 px-1 -mx-1 py-0.5 text-xs">
      <AlertCircle className="h-3 w-3 shrink-0 text-destructive mt-0.5" />
      <span className="text-destructive">{item.content}</span>
    </div>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────
