"use client";

import { isMemberQuestionReminder, LinkedQuestion, linkedQuestionId, QuestionReplyReference } from "../../common/linked-question";
import { questionReplyText } from "../../common/question-answer";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useAfterFirstScreen } from "@multiremi/core/platform/use-after-first-screen";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { api } from "@multiremi/core/api";
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
import { ChevronRight, ChevronDown, AlertCircle, AlertTriangle, CircleSlash, Copy, LoaderCircle, Check, RotateCcw, ScrollText } from "lucide-react";
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
import { failureReasonLabel } from "../../agents/components/tabs/task-failure";
import { TaskStatusPill } from "./task-status-pill";
import { useTurnTrace } from "../../common/task-transcript/use-task-trace";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { formatElapsedMs } from "../../common/format";
import { extractCopyText } from "../lib/copy-text";
import { finishedFoldHeader, isAwaitingHuman } from "../lib/turn-steps";
import { isNonterminalTurn } from "../lib/turn-card";
import { FinishedTurnSteps, LiveTurnSteps } from "./turn-steps-fold";
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

/** The canonical turn card behind a reply row: the reply owns the turn's outcome. */
interface TurnCardRef {
  turnId: string;
  attemptId: string | null;
  status: string | null;
  failureReason: string | null;
  steps: TurnStepsRef | null;
}

/**
 * What a finished turn's steps fold needs from its card, without its trace:
 * the card counted process items (PR 2; older cards carry no count and get no
 * fold) and says how long the agent worked.
 */
interface TurnStepsRef {
  attemptId: string;
  turnId: string;
  status: string | null;
  workedMs: number | null;
  elapsedMs: number | null;
}

const metadataNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function turnStepsRef(metadata: Record<string, unknown> | undefined, attemptId: string | null | undefined): TurnStepsRef | null {
  const count = metadataNumber(metadata?.process_item_count);
  if (!count || !attemptId || typeof metadata?.turn_id !== "string") return null;
  return {
    attemptId,
    turnId: metadata.turn_id,
    status: typeof metadata.status === "string" ? metadata.status : null,
    workedMs: metadataNumber(metadata.worked_ms),
    elapsedMs: metadataNumber(metadata.elapsed_ms),
  };
}

/** Row heights are cached per render version; an open fold is a different layout. */
const STEPS_OPEN_VERSION = ":steps-open";

const endedBadly = (status: string | null | undefined): status is "failed" | "cancelled" =>
  status === "failed" || status === "cancelled";

/**
 * A terminal Chat turn writes a card row and a separate reply message row
 * (`final_entry_id`). The card comes first, so showing both would put the
 * outcome above the reply and repeat a failure. Map each reply to its card.
 */
function turnCardsByReply(entries: readonly SessionLogEntry[]): Map<string, TurnCardRef> {
  const cards = new Map<string, TurnCardRef>();
  for (const entry of entries) {
    const row = entry as SessionLogEntry & { task_id?: string | null; metadata?: Record<string, unknown> };
    const metadata = row.metadata;
    if (row.kind !== "turn" || typeof metadata?.turn_id !== "string" || typeof metadata.final_entry_id !== "string") continue;
    cards.set(metadata.final_entry_id, {
      turnId: metadata.turn_id,
      attemptId: row.task_id ?? null,
      status: typeof metadata.status === "string" ? metadata.status : null,
      failureReason: typeof metadata.failure_reason === "string" ? metadata.failure_reason : null,
      steps: turnStepsRef(metadata, row.task_id),
    });
  }
  return cards;
}

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
  // Which finished turns have their steps open, by row id. Lifted here so the
  // row's render version tells the height cache open and closed apart.
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set());
  const setStepsOpen = useCallback((rowId: string, open: boolean) => {
    setOpenSteps((current) => {
      if (current.has(rowId) === open) return current;
      const next = new Set(current);
      if (open) next.add(rowId); else next.delete(rowId);
      return next;
    });
  }, []);
  const transformEntries = useCallback((entries: readonly SessionLogEntry[]) => {
    const replies = new Set(entries.filter(entry => entry.kind === "message"
      && !(entry as SessionLogEntry & { deleted_at?: string | null }).deleted_at).map(entry => entry.id));
    return mergeOptimisticChatRows(entries.filter(entry => {
      const row = entry as SessionLogEntry & { author_type?: string; sender_type?: string; message_kind?: string; deleted_at?: string | null; metadata?: Record<string, unknown>; to_type?: string | null };
      if (row.seq === 0 || row.deleted_at) return false;
      // A card whose reply row is loaded adds nothing of its own: the reply
      // row shows the outcome, its retry and the execution log.
      if (row.kind === "turn" && typeof row.metadata?.turn_id === "string"
        && typeof row.metadata.final_entry_id === "string" && replies.has(row.metadata.final_entry_id)) return false;
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
      const steps = openSteps.has(entry.id) ? STEPS_OPEN_VERSION : "";
      return { ...entry, render_version: `${entry.render_version ?? ""}${question}${CHAT_LAYOUT_VERSION}${steps}` };
    }), optimisticRows);
  }, [optimisticRows, openSteps]);
  const cardsByReply = useMemo(() => turnCardsByReply(snapshot.entries), [snapshot.entries]);
  const entryKey = useCallback((entry: SessionLogEntry) => clientIdOf(entry) ?? entry.id, []);
  const pendingTaskId = pendingTask?.task_id ?? null;
  const pendingAlreadyPersisted = !!pendingTaskId && replica.getSnapshot(sessionId).entries.some((entry) => {
    const row = entry as SessionLogEntry & { task_id?: string; metadata?: Record<string, unknown> };
    return row.kind === "turn" && row.task_id === pendingTaskId
      && !isNonterminalTurn(row.metadata);
  });
  const showLiveTimeline = !!pendingTaskId && !pendingAlreadyPersisted;
  // An optimistic pending id has no trace yet; the real id replaces it on dispatch.
  const liveTraceId = pendingTaskId?.startsWith("optimistic-") ? null : pendingTaskId;
  const liveTrace = useTurnTrace(liveTraceId, { enabled: visible && showLiveTimeline, live: true, turnId: pendingTask?.turn_id });
  // The pill says only what the steps fold cannot: the wait before the trace
  // has a turn (queued, dispatched, offline, the directory lock, preparation),
  // a read that failed or a legacy trace (no fold), and a wait on a person.
  const foldShown = !!liveTrace.turn && liveTrace.read?.format !== "legacy";
  const waitingOnHuman = pendingTask?.status === "awaiting_human" || isAwaitingHuman(liveTrace.items);
  const showStatusPill = !!pendingTaskId && !pendingAlreadyPersisted && !!pendingTask && !liveTrace.closed
    && (!foldShown || waitingOnHuman);

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
        message_kind?: SessionLogRow["message_kind"];
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
      // A reply row carries its turn's outcome; a reply whose card is outside
      // the window still reaches the log through its own turn id.
      const card = row.kind === "message" ? cardsByReply.get(row.id) : undefined;
      const trace = card ? { taskId: card.attemptId ?? card.turnId, turnId: card.turnId }
        : row.kind === "message" && !isUser && row.message_kind === "reply" && row.task_id ? { taskId: row.task_id, turnId: row.task_id }
          : null;
      // A finished turn whose card counted process items folds its steps above
      // the reply (or the failure notice); older cards have no count and no fold.
      const stepsRef = card ? card.steps : row.kind === "turn" && !isPush ? turnStepsRef(row.metadata, row.task_id) : null;
      // A failed or cancelled turn's notice carries its own execution log.
      const endNotice = !!(card && endedBadly(card.status)) || !!(turnId && endedBadly(turnStatus));
      const stepsFold = stepsRef ? <FinishedTurnSteps attemptId={stepsRef.attemptId} turnId={stepsRef.turnId}
        header={finishedFoldHeader(stepsRef)} visible={visible} open={openSteps.has(row.id)}
        onOpenChange={(open) => setStepsOpen(row.id, open)}
        footer={endNotice ? undefined : <ChatTraceButton taskId={stepsRef.attemptId} turnId={stepsRef.turnId} visible={visible} />} /> : null;
      return <div className="group/message">
        {questionId ? <LinkedQuestion id={questionId} getActorName={getActorName} /> : null}
        {card && endedBadly(card.status)
          ? <div className="space-y-3">{stepsFold}<TurnEndNotice turnId={card.turnId} attemptId={card.attemptId} status={card.status}
            failureReason={card.failureReason ?? message.failure_reason ?? null} details={message.content} visible={visible} /></div>
          : turnId && endedBadly(turnStatus)
            ? <div className="space-y-3">{stepsFold}<TurnEndNotice turnId={turnId} attemptId={row.task_id ?? null} status={turnStatus}
              failureReason={message.failure_reason ?? null} details={message.content} visible={visible} /></div>
            : row.kind === "turn" && row.metadata?.final_entry_id
              // The reply row is not loaded; a finished card has nothing of its own to show.
              ? null
              : <MessageBubble message={message} isPending={!!pendingTaskId && row.task_id === pendingTaskId}
                isPush={isPush} visible={visible} trace={trace} steps={stepsFold} />}
        {isUser && <NotWokenHint wakeApplied={row.wake_applied} wakeReason={row.wake_reason} />}
        {row.kind === "message" && !questionId && <QuestionReplyReference metadata={row.metadata} />}
        {isUser && local && <div className="flex justify-end"><SendStatus status={local.status}
          onRetry={() => onRetrySend?.(local.clientId)} /></div>}
      </div>;
    }}
    footer={<div className="space-y-4 pb-4">
      {showLiveTimeline && <LiveTurnSteps key={liveTraceId ?? "pending"} trace={liveTrace} />}
      {showLiveTimeline && liveTrace.error && <div role="alert" className="text-xs text-destructive">{traceT(($) => $.transcript.trace_failed)}</div>}
      {showStatusPill && pendingTask && <TaskStatusPill pendingTask={pendingTask}
        items={liveTrace.items} availability={availability} />}
    </div>} />;
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

type TraceRef = { taskId: string; turnId?: string } | null;

function MessageBubble({ message, isPending, isPush, visible, trace = null, steps = null }: {
  message: ChatMessage; isPending: boolean; isPush: boolean; visible: boolean; trace?: TraceRef;
  /** The finished turn's steps fold, rendered above the reply. */
  steps?: React.ReactNode;
}) {
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

  return <AssistantMessage message={message} isPending={isPending} isPush={isPush} visible={visible} trace={trace} steps={steps} />;
}

function AssistantMessage({
  message,
  isPending,
  isPush,
  visible,
  trace,
  steps,
}: {
  message: ChatMessage;
  isPending: boolean;
  isPush: boolean;
  visible: boolean;
  trace: TraceRef;
  steps: React.ReactNode;
}) {
  const traceRef: TraceRef = trace ?? (message.task_id && !isPush ? { taskId: message.task_id, turnId: message.turn_id } : null);

  // Legacy failure bubble: an assistant row written by the server's FailTask
  // fallback before turns carried their own status. Canonical failed turns
  // render TurnEndNotice instead.
  if (message.failure_reason) {
    return (
      <div className="w-full space-y-1.5"><FailureBubble
        reason={message.failure_reason}
        rawError={message.content}
        elapsedMs={message.elapsed_ms}
      />
        {traceRef && <ChatTraceButton taskId={traceRef.taskId} turnId={traceRef.turnId} visible={visible} />}
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      {steps && <div className="pb-1.5">{steps}</div>}
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
        isPending={isPending}
        // The steps fold carries the execution log for the turns that have one.
        trace={traceRef && !steps
          ? <ChatTraceButton taskId={traceRef.taskId} turnId={traceRef.turnId} visible={visible} quiet /> : null}
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
  isPending,
  trace,
}: {
  message: ChatMessage;
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
      {showCopy && <MessageCopyButton message={message} />}
      {trace}
    </div>
  );
}

function MessageCopyButton({ message }: { message: ChatMessage }) {
  const { t } = useT("chat");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const handleCopy = async () => {
    if (await copyText(extractCopyText(message))) {
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
  elapsedMs,
}: {
  reason: string;
  rawError: string;
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
      {elapsedMs != null && (
        <ElapsedCaption variant="failed" elapsedMs={elapsedMs} />
      )}
    </div>
  );
}
