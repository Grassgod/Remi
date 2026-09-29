"use client";

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
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
import { ChevronRight, ChevronDown, Brain, AlertCircle, AlertTriangle, Copy, LoaderCircle, Check } from "lucide-react";
import { isTaskMessageTaskId, taskMessagesOptions } from "@multiremi/core/chat/queries";
import { AttachmentSchema } from "@multiremi/core/api/schemas";
import type { SessionLogEntry, SessionReplicaPort } from "@multiremi/core/replica";
import { Markdown } from "@multiremi/views/common/markdown";
import { SessionLogList } from "../../common/session-log/session-log-list";
import { EntryHtml } from "../../common/session-log/entry-html";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { AttachmentList } from "../../issues/components/comment-card";
import type { AgentAvailability } from "@multiremi/core/agents";
import type { ChatMessage, ChatPendingTask, TaskFailureReason } from "@multiremi/core/types";
import type { ChatTimelineItem } from "@multiremi/core/chat";
import { failureReasonLabel } from "../../agents/components/tabs/task-failure";
import { toChatTimeline } from "../lib/chat-timeline";
import { chatMessageMarkdown } from "../lib/message-attachments";
import { TaskStatusPill } from "./task-status-pill";
import { formatElapsedMs } from "../../common/format";
import { splitTimeline, extractCopyText } from "../lib/copy-text";
import { useT } from "../../i18n";
import { clientIdOf, mergeOptimisticChatRows, type OptimisticChatRow } from "../lib/optimistic-log";

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
  const scrollRoot = useRef<HTMLElement | null>(null);
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);
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
    mergeOptimisticChatRows(entries.filter(entry => entry.seq > 0), optimisticRows), [optimisticRows]);
  const entryKey = useCallback((entry: SessionLogEntry) => clientIdOf(entry) ?? entry.id, []);
  const pendingTaskId = pendingTask?.task_id ?? null;
  const pendingAlreadyPersisted = !!pendingTaskId && replica.getSnapshot(sessionId).entries.some((entry) => {
    const row = entry as SessionLogEntry & { task_id?: string; metadata?: Record<string, unknown> };
    return row.kind === "turn" && row.task_id === pendingTaskId
      && !isNonterminalTurn(row.metadata);
  });
  const showLiveTimeline = !!pendingTaskId && !pendingAlreadyPersisted;
  const canFetchLiveTimeline = isTaskMessageTaskId(pendingTaskId) && !pendingAlreadyPersisted;
  const { data: liveTaskMessages } = useQuery({
    ...taskMessagesOptions(pendingTaskId ?? ""),
    enabled: visible && canFetchLiveTimeline,
  });
  const liveTimeline: ChatTimelineItem[] = toChatTimeline(liveTaskMessages ?? []);
  const hasLive = showLiveTimeline && liveTimeline.length > 0;
  const showStatusPill = !!pendingTaskId && !pendingAlreadyPersisted && !!pendingTask;

  return <SessionLogList sessionId={sessionId} replica={replica} perfScroll="session-log"
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
        author_type?: string; task_id?: string | null; created_at?: string;
        metadata?: Record<string, unknown>;
      };
      if (row.kind !== "message" && row.kind !== "turn") {
        return <div className="text-xs text-muted-foreground"><EntryHtml html={row.body_html} markdown={row.body_md} /></div>;
      }
      const isUser = row.kind === "message" && row.author_type === "member";
      if (row.kind === "message" && !isUser) {
        return <div className="text-xs text-muted-foreground"><EntryHtml html={row.body_html} markdown={row.body_md} /></div>;
      }
      const message: ChatMessage = {
        id: row.id, chat_session_id: sessionId, role: isUser ? "user" : "assistant",
        content: isUser ? row.body_md : String(row.metadata?.final_reply_md ?? row.body_md),
        task_id: row.task_id ?? null, created_at: row.created_at ?? "",
        failure_reason: typeof row.metadata?.failure_reason === "string" ? row.metadata.failure_reason : null,
          elapsed_ms: typeof row.metadata?.elapsed_ms === "number" ? row.metadata.elapsed_ms : null,
          attachments: AttachmentSchema.array().safeParse(row.metadata?.attachments).data as ChatMessage["attachments"],
      };
      const clientId = clientIdOf(entry);
      const local = optimisticRows.find((item) => item.clientId === clientId);
      const isPush = row.kind === "turn" && isNonterminalTurn(row.metadata);
      return <div className="py-2">
        <MessageBubble message={message} isPending={!!pendingTaskId && row.task_id === pendingTaskId}
          isPush={isPush} visible={visible} />
        {isUser && local && <div className="flex justify-end"><SendStatus status={local.status}
          onRetry={() => onRetrySend?.(local.clientId)} /></div>}
      </div>;
    }}
    footer={<div className="space-y-4 pb-4">
      {hasLive && <TimelineView items={liveTimeline} isStreaming />}
      {showStatusPill && pendingTask && <TaskStatusPill pendingTask={pendingTask}
        taskMessages={liveTaskMessages ?? []} availability={availability} />}
    </div>} />;
}

function isNonterminalTurn(metadata?: Record<string, unknown>): boolean {
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
    const markdown = chatMessageMarkdown(message);
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl bg-muted px-3.5 py-2 text-sm max-w-[80%] break-words">
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
  const taskId = message.task_id;
  // A mid-run attachment push shares its task id with the terminal reply that
  // follows. The timeline belongs to that reply: drawing it here would both
  // displace this row's own caption and, once the reply lands, repeat the
  // whole timeline a second time.
  const canFetchTaskMessages = isTaskMessageTaskId(taskId) && !isPush;

  // Use the shared taskMessagesOptions so this cache entry is the same one
  // seeded by useRealtimeSync during task execution — zero refetch when the
  // task finishes, since WS already populated it.
  const { data: taskMessages } = useQuery({
    ...taskMessagesOptions(taskId ?? ""),
    enabled: visible && canFetchTaskMessages,
  });

  const timeline: ChatTimelineItem[] = isPush
    ? []
    : toChatTimeline(taskMessages ?? []);

  // Failure bubble path: when the server's FailTask wrote a failure
  // chat_message (failure_reason set), render a destructive bubble with the
  // human-readable reason label + collapsible raw errMsg + the same timeline
  // so the user can see exactly where the run broke.
  if (message.failure_reason) {
    return (
      <FailureBubble
        reason={message.failure_reason}
        rawError={message.content}
        timeline={timeline}
        elapsedMs={message.elapsed_ms}
      />
    );
  }

  return (
    <div className="w-full space-y-1.5">
      {timeline.length > 0 ? (
        <TimelineView items={timeline} attachments={message.attachments} />
      ) : (
        <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
          <Markdown attachments={message.attachments}>{message.content}</Markdown>
        </div>
      )}
      <AttachmentList
        attachments={message.attachments}
        content={message.content}
      />
      <MessageFooter
        message={message}
        timeline={timeline}
        isPending={isPending}
      />
    </div>
  );
}

// Inline footer row beneath the assistant reply: "Replied in 38s · [Copy]".
// Action icons live here (not as a hover-floating overlay) so they're
// discoverable on first read and don't shift content. Buttons stay quiet
// (muted) until hover. Copy is suppressed during streaming because the
// final text is still being appended.
function MessageFooter({
  message,
  timeline,
  isPending,
}: {
  message: ChatMessage;
  timeline: ChatTimelineItem[];
  isPending: boolean;
}) {
  const showCopy = !isPending;
  if (message.elapsed_ms == null && !showCopy) return null;
  return (
    <div className="flex items-center gap-1.5">
      {message.elapsed_ms != null && (
        <ElapsedCaption variant="replied" elapsedMs={message.elapsed_ms} />
      )}
      {showCopy && <MessageCopyButton message={message} timeline={timeline} />}
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
  const handleCopy = async () => {
    if (await copyText(extractCopyText(message, timeline))) {
      toast.success(t(($) => $.message_list.copied_toast));
    } else {
      toast.error(t(($) => $.message_list.copy_failed_toast));
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground/70 hover:text-foreground"
            onClick={handleCopy}
            aria-label={t(($) => $.message_list.copy_action)}
          />
        }
      >
        <Copy />
      </TooltipTrigger>
      <TooltipContent side="top">
        {t(($) => $.message_list.copy_action)}
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
