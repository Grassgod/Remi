"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CirclePause, Loader2, MoreHorizontal, Paperclip, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { cn } from "@multiremi/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useChatStore, type ChatQueueOutboxItem } from "@multiremi/core/chat";
import { chatKeys, chatQueueOptions } from "@multiremi/core/chat/queries";
import {
  CHAT_QUEUE_MUTATION_KEY,
  useDeleteQueuedChatMessage,
  useEnqueueChatMessage,
  useResumeChatQueue,
  useSteerQueuedChatMessage,
  type QueuedChatMessageVariables,
} from "@multiremi/core/chat/mutations";
import {
  QUEUE_MAX_LIVE_ITEMS,
  isQueueConsumed,
  isQueueDeliveryUnconfirmed,
  queuedAttachmentBindings,
  queueErrorCode,
  queueErrorItem,
  queuePreviewText,
  truncatePreview,
  type QueuedChatMessage,
} from "@multiremi/core/chat/queue";
import { useT } from "../../i18n";

/** Undo window before a deleted row is really deleted (R7). */
export const QUEUE_DELETE_UNDO_MS = 5_000;
/** Full text appears after hovering a row this long (Codex). */
export const QUEUE_PREVIEW_DELAY_MS = 700;
/** An idle lane holding rows is "stalled" only after this grace period. */
export const QUEUE_STALLED_GRACE_MS = 2_000;

const EMPTY_OUTBOX: ChatQueueOutboxItem[] = [];

type RowState = "queued" | "sending" | "editing" | "failed" | "unconfirmed";
type Row =
  | { kind: "server"; key: string; item: QueuedChatMessage; state: RowState }
  | { kind: "outbox"; key: string; item: ChatQueueOutboxItem; state: RowState };

interface PendingDelete {
  timer: ReturnType<typeof setTimeout>;
  toastId: string | number;
  commit: () => Promise<void>;
}

/** Lets the composer settle deletes still behind their undo before it enqueues. */
export interface ChatQueueController {
  flushDeletes: () => Promise<void>;
}

/**
 * The text for a refused queue command. Archived Chats and full queues say
 * what to do; other refusals fall back to the generic failure.
 */
export function useQueueRefusalText(): (error: unknown) => string {
  const { t } = useT("chat");
  return (error) => {
    const code = queueErrorCode(error);
    if (code === "chat_archived") return t(($) => $.queue.archived);
    if (code === "queue_full") return t(($) => $.queue.full, { max: QUEUE_MAX_LIVE_ITEMS });
    return t(($) => $.queue.failed);
  };
}

/**
 * The Chat follow-up queue above the composer (ADR 0020): rows that wait for
 * the current turn to complete. Each row can be steered into the running turn
 * now, edited through the composer, or deleted with a 5 s undo.
 *
 * Mounted only inside a visible chat, so its query never runs for a hidden
 * window (MUL-472).
 */
export function ChatQueue({
  sessionId,
  pendingTaskId,
  archived = false,
  onReleased,
  controllerRef,
}: {
  sessionId: string;
  /** The running turn; its changes refresh the queue and drive the stalled banner. */
  pendingTaskId: string | null;
  /** An archived Chat cannot release rows: steer, resume and retry are disabled. */
  archived?: boolean;
  /** A row became a log message; the caller refreshes the conversation. */
  onReleased?: () => void;
  controllerRef?: MutableRefObject<ChatQueueController | null>;
}) {
  const { t } = useT("chat");
  const refusalText = useQueueRefusalText();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const query = useQuery(chatQueueOptions(wsId, sessionId));
  const serverItems = useMemo(() => query.data?.items ?? [], [query.data]);
  const paused = query.data?.paused ?? null;
  const outbox = useChatStore((s) => s.queueOutbox[sessionId] ?? EMPTY_OUTBOX);
  const queueEdit = useChatStore((s) => s.queueEdit[sessionId]);
  const isRunning = !!pendingTaskId;

  const steer = useSteerQueuedChatMessage();
  const { mutateAsync: deleteQueued } = useDeleteQueuedChatMessage();
  const resume = useResumeChatQueue();
  const { mutateAsync: enqueue } = useEnqueueChatMessage();

  // Rows with a steer, edit or delete in flight, whichever component sent it.
  const sendingIds = useMutationState({
    filters: { mutationKey: CHAT_QUEUE_MUTATION_KEY, status: "pending" },
    select: (mutation) => {
      const vars = mutation.state.variables as Partial<QueuedChatMessageVariables> | undefined;
      return vars?.sessionId === sessionId ? vars.itemId : undefined;
    },
  });
  const sending = useMemo(() => new Set(sendingIds.filter((id): id is string => !!id)), [sendingIds]);

  // A turn starting or ending can release or pause the queue. Optimistic
  // placeholders are skipped: only the server's turn identity matters. The
  // stalled check waits for an answer read after the change.
  const lastTaskRef = useRef(pendingTaskId);
  const [taskChangedAt, setTaskChangedAt] = useState(0);
  useEffect(() => {
    if (pendingTaskId?.startsWith("optimistic-") || lastTaskRef.current === pendingTaskId) return;
    lastTaskRef.current = pendingTaskId;
    setTaskChangedAt(Date.now());
    void qc.invalidateQueries({ queryKey: chatKeys.queue(wsId, sessionId) });
  }, [pendingTaskId, qc, wsId, sessionId]);

  // Client-only state: rows hidden behind an undo toast, and server rows whose
  // steer failed without an HTTP answer.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const pendingDeletes = useRef(new Map<string, PendingDelete>());
  const mounted = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);
  const previewRefs = useRef(new Map<string, HTMLElement>());

  const setMember = (set: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> => {
    if (set.has(key) === present) return set;
    const next = new Set(set);
    if (present) next.add(key);
    else next.delete(key);
    return next;
  };

  /** Sends a delete now. Its Undo disappears first, so it can never appear to work afterwards. */
  const flushDelete = useCallback((key: string): Promise<void> => {
    const pending = pendingDeletes.current.get(key);
    if (!pending) return Promise.resolve();
    clearTimeout(pending.timer);
    pendingDeletes.current.delete(key);
    toast.dismiss(pending.toastId);
    return pending.commit();
  }, []);

  /**
   * Settles every delete still behind its undo. The server still holds those
   * rows as queued, so anything that releases rows (resume, an enqueue on an
   * idle lane) must wait for it.
   */
  const flushDeletes = useCallback(
    () => Promise.all([...pendingDeletes.current.keys()].map(flushDelete)).then(() => undefined),
    [flushDelete],
  );

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = { flushDeletes };
    return () => {
      if (controllerRef.current?.flushDeletes === flushDeletes) controllerRef.current = null;
    };
  }, [controllerRef, flushDeletes]);

  // Leaving the chat (unmount or a session switch, which remounts this list)
  // sends every delete still waiting behind its undo toast.
  useEffect(() => {
    mounted.current = true;
    const deletes = pendingDeletes.current;
    return () => {
      mounted.current = false;
      for (const key of [...deletes.keys()]) void flushDelete(key);
    };
  }, [flushDelete]);

  // Reconcile client state with the server list.
  const serverIds = useMemo(() => new Set(serverItems.map((item) => item.id)), [serverItems]);
  const serverClientIds = useMemo(() => new Set(serverItems.map((item) => item.client_id)), [serverItems]);
  useEffect(() => {
    if (!query.data) return;
    // A row the server lists is no longer unconfirmed.
    for (const item of outbox) {
      if (serverClientIds.has(item.client_id)) useChatStore.getState().removeQueueOutboxItem(sessionId, item.client_id);
    }
    // A row that left the list during its undo was sent at turn end or
    // deleted elsewhere. Send the DELETE now: a sent row answers 409, which
    // tells the user; a deleted one answers quietly.
    for (const key of [...pendingDeletes.current.keys()]) {
      if (key.startsWith("server:") && !serverIds.has(key.slice("server:".length))) void flushDelete(key);
    }
    setHidden((current) => {
      const next = [...current].filter((key) => !key.startsWith("server:") || serverIds.has(key.slice("server:".length))
        || pendingDeletes.current.has(key));
      return next.length === current.size ? current : new Set(next);
    });
    setUnconfirmed((current) => {
      const next = [...current].filter((id) => serverIds.has(id));
      return next.length === current.size ? current : new Set(next);
    });
  }, [query.data, outbox, serverIds, serverClientIds, sessionId, flushDelete]);

  // The row being edited left the queue (the turn released it, or another tab
  // deleted it): keep the edited text as an ordinary draft. The list cannot
  // tell which, so the notice names both.
  useEffect(() => {
    if (!queueEdit || !query.isSuccess || query.isFetching || serverIds.has(queueEdit.itemId)) return;
    useChatStore.getState().finishQueueEdit(sessionId, "keep");
    toast(t(($) => $.queue.left_queue));
  }, [queueEdit, query.isSuccess, query.isFetching, serverIds, sessionId, t]);

  const rows: Row[] = [
    ...serverItems
      .filter((item) => !hidden.has(`server:${item.id}`))
      .map((item): Row => ({
        kind: "server", key: `server:${item.id}`, item,
        state: sending.has(item.id) ? "sending"
          : queueEdit?.itemId === item.id ? "editing"
            : unconfirmed.has(item.id) ? "unconfirmed"
              : item.status === "failed" ? "failed" : "queued",
      })),
    ...outbox
      .filter((item) => !serverClientIds.has(item.client_id) && !hidden.has(`outbox:${item.client_id}`))
      .map((item): Row => ({
        kind: "outbox", key: `outbox:${item.client_id}`, item,
        state: item.state === "sending" ? "sending" : "unconfirmed",
      })),
  ];

  // Rows wait while the lane is idle and nothing paused it: a release was
  // missed (for example the Chat was archived mid-run). After a grace period
  // the banner offers Resume. It is latched to the rows, the pause and the
  // turn, so background refetches of the same answer do not reset it.
  const queuedIds = rows
    .filter((row) => row.kind === "server" && row.item.status === "queued")
    .map((row) => row.key)
    .join(",");
  const stalledKey = !paused && !isRunning && queuedIds && query.dataUpdatedAt >= taskChangedAt
    ? `${pendingTaskId ?? ""}|${queuedIds}`
    : null;
  const [stalledShownFor, setStalledShownFor] = useState<string | null>(null);
  useEffect(() => {
    if (!stalledKey) return;
    const timer = setTimeout(() => setStalledShownFor(stalledKey), QUEUE_STALLED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [stalledKey]);
  const stalled = stalledKey !== null && stalledShownFor === stalledKey;

  const [resuming, setResuming] = useState(false);
  const runResume = async () => {
    setResuming(true);
    try {
      await flushDeletes();
      const result = await resume.mutateAsync({ sessionId });
      if (result.released.length) onReleased?.();
    } catch (error) {
      toast.error(refusalText(error));
    } finally {
      if (mounted.current) setResuming(false);
    }
  };

  const runSteer = (item: QueuedChatMessage) => {
    setUnconfirmed((current) => setMember(current, item.id, false));
    steer.mutate({ sessionId, itemId: item.id }, {
      onSuccess: () => onReleased?.(),
      onError: (error) => {
        if (isQueueConsumed(error)) toast(t(($) => $.queue.consumed));
        else if (isQueueDeliveryUnconfirmed(error)) setUnconfirmed((current) => setMember(current, item.id, true));
        // A failed release is written into the row (failed, lane paused).
        else if (!queueErrorItem(error)) toast.error(refusalText(error));
      },
    });
  };

  /** Text the queue cannot keep goes back into the composer, never lost. */
  const restoreToDraft = (item: ChatQueueOutboxItem) => {
    useChatStore.getState().restoreToDraft(sessionId, item.body_md, queuedAttachmentBindings(item.body_md, item.attachments));
  };

  const retryEnqueue = (item: ChatQueueOutboxItem) => {
    enqueue({
      sessionId, body_md: item.body_md, attachment_ids: item.attachment_ids, attachments: item.attachments,
      client_id: item.client_id, created_at: item.created_at,
    }).then((result) => { if (result.released) onReleased?.(); }, (error: unknown) => {
      // Unconfirmed again: the row stays for another try. A row deleted
      // elsewhere just leaves the list.
      if (isQueueDeliveryUnconfirmed(error) || queueErrorCode(error) === "queued_message_deleted") return;
      restoreToDraft(item);
      toast.error(refusalText(error), { description: t(($) => $.queue.restored_to_draft) });
    });
  };

  const startEdit = (row: Row) => {
    if (row.kind === "server") {
      useChatStore.getState().startQueueEdit(sessionId, {
        itemId: row.item.id, revision: row.item.revision, body_md: row.item.body_md,
        attachments: queuedAttachmentBindings(row.item.body_md, row.item.attachments),
      });
      return;
    }
    // Without a server row there is nothing to save to: the text goes back
    // into the composer as an ordinary draft.
    restoreToDraft(row.item);
    useChatStore.getState().removeQueueOutboxItem(sessionId, row.item.client_id);
  };

  /** Keyboard focus after a row disappears: the next row, the previous one, or the composer. */
  const focusAfterRemoval = (key: string) => {
    const index = rows.findIndex((row) => row.key === key);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    // Resolved now: the list unmounts once its last row is hidden.
    let scope: HTMLElement | null | undefined = sectionRef.current?.parentElement;
    while (scope && !scope.querySelector("[data-chat-composer]")) scope = scope.parentElement;
    const composer = scope?.querySelector<HTMLElement>("[data-chat-composer] [contenteditable='true']");
    setTimeout(() => {
      const target = neighbour ? previewRefs.current.get(neighbour.key) : null;
      (target ?? composer)?.focus();
    }, 0);
  };

  const scheduleDelete = (row: Row) => {
    const key = row.key;
    if (pendingDeletes.current.has(key)) return;
    if (row.kind === "server" && queueEdit?.itemId === row.item.id) {
      useChatStore.getState().finishQueueEdit(sessionId, "restore");
    }
    const commit = row.kind === "server"
      ? () => deleteQueued({ sessionId, itemId: row.item.id }).then(() => undefined, (error: unknown) => {
          if (mounted.current) setHidden((current) => setMember(current, key, false));
          if (isQueueConsumed(error)) toast(t(($) => $.queue.sent_before_delete));
          else toast.error(refusalText(error));
        })
      : async () => {
          useChatStore.getState().removeQueueOutboxItem(sessionId, row.item.client_id);
          if (mounted.current) setHidden((current) => setMember(current, key, false));
        };
    focusAfterRemoval(key);
    setHidden((current) => setMember(current, key, true));
    const toastId = toast(t(($) => $.queue.deleted), {
      duration: QUEUE_DELETE_UNDO_MS,
      action: {
        label: t(($) => $.queue.undo),
        onClick: () => {
          const pending = pendingDeletes.current.get(key);
          if (!pending) {
            toast(t(($) => $.queue.undo_unavailable));
            return;
          }
          clearTimeout(pending.timer);
          pendingDeletes.current.delete(key);
          if (mounted.current) setHidden((current) => setMember(current, key, false));
        },
      },
    });
    const timer = setTimeout(() => void flushDelete(key), QUEUE_DELETE_UNDO_MS);
    pendingDeletes.current.set(key, { timer, toastId, commit });
  };

  if (!rows.length) return null;

  const banner = paused?.reason === "interrupted" ? t(($) => $.queue.interrupted)
    : paused?.reason === "turn_ended" ? t(($) => $.queue.turn_ended)
      : paused && paused.reason !== "send_failed" ? t(($) => $.queue.stalled)
        : stalled ? t(($) => $.queue.stalled) : null;
  const archivedHint = archived ? t(($) => $.queue.archived) : null;

  return (
    <div className="shrink-0 px-5">
      <section
        ref={sectionRef}
        aria-label={t(($) => $.queue.title)}
        data-chat-queue=""
        className="mx-auto mb-2 max-h-[30dvh] w-full max-w-4xl overflow-y-auto rounded-lg border bg-card text-sm"
      >
        {banner && (
          <div role="status" className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <CirclePause className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{banner}</span>
            <HintedButton hint={archivedHint} disabled={resume.isPending || resuming} onClick={() => void runResume()}>
              {t(($) => $.queue.resume)}
            </HintedButton>
          </div>
        )}
        <ul className="divide-y">
          {rows.map((row, index) => (
            <QueueRow
              key={row.key}
              row={row}
              position={index + 1}
              archivedHint={archivedHint}
              previewRef={(element) => {
                if (element) previewRefs.current.set(row.key, element);
                else previewRefs.current.delete(row.key);
              }}
              onSteer={() => row.kind === "server" && runSteer(row.item)}
              onRetry={() => {
                if (row.kind === "outbox") retryEnqueue(row.item);
                else if (row.state === "unconfirmed") runSteer(row.item);
                else void runResume();
              }}
              onEdit={() => startEdit(row)}
              onDelete={() => scheduleDelete(row)}
              // One edit at a time: opening another would drop unsaved text.
              editDisabled={!!queueEdit}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * A small action button. With a `hint` (an archived Chat) it stays focusable
 * but inert and explains why in a tooltip; a disabled button shows none.
 */
function HintedButton({
  hint,
  disabled,
  onClick,
  label,
  tooltip,
  children,
}: {
  hint: string | null;
  disabled?: boolean;
  onClick: () => void;
  label?: string;
  tooltip?: string;
  children: ReactNode;
}) {
  const content = hint ?? tooltip;
  const props = {
    variant: "ghost" as const,
    size: "xs" as const,
    className: cn("shrink-0", hint && "cursor-not-allowed opacity-50"),
    "aria-label": label,
    "aria-disabled": hint ? true : undefined,
    disabled: !hint && disabled,
    onClick: () => { if (!hint) onClick(); },
  };
  if (!content) return <Button {...props}>{children}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button {...props} />}>{children}</TooltipTrigger>
      <TooltipContent side="top" className="block max-w-xs">{content}</TooltipContent>
    </Tooltip>
  );
}

function QueueRow({
  row,
  position,
  archivedHint,
  previewRef,
  onSteer,
  onRetry,
  onEdit,
  onDelete,
  editDisabled,
}: {
  row: Row;
  position: number;
  archivedHint: string | null;
  previewRef: (element: HTMLElement | null) => void;
  onSteer: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onDelete: () => void;
  editDisabled: boolean;
}) {
  const { t } = useT("chat");
  const body = row.item.body_md;
  const preview = queuePreviewText(body);
  const attachmentCount = row.item.attachments.length;
  const { state } = row;
  const busy = state === "sending";
  const warning = state === "failed"
    ? [t(($) => $.queue.paused_tooltip), t(($) => $.queue.paused_remedy)]
    : state === "unconfirmed" ? [t(($) => $.queue.delivery_unconfirmed)] : null;
  // Edit and delete move focus elsewhere; the menu must not take it back.
  const focusMovesAway = useRef(false);

  return (
    <li
      aria-label={t(($) => $.queue.preview_label, { position, preview: truncatePreview(preview) })}
      aria-busy={busy || undefined}
      data-state={state}
      className={cn("flex min-w-0 items-center gap-2 px-3 py-1.5", (busy || state === "editing") && "opacity-60")}
    >
      {busy ? (
        <Loader2 role="img" aria-label={t(($) => $.queue.sending)} className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : warning ? (
        <Tooltip>
          <TooltipTrigger
            render={<span role="img" tabIndex={0} aria-label={warning.join(" ")} className="shrink-0 text-warning" />}
          >
            <TriangleAlert className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top" className="block max-w-xs">
            {warning.map((line) => <p key={line}>{line}</p>)}
            {row.kind === "server" && row.item.error && state === "failed" && (
              <p className="mt-1 text-muted-foreground">{row.item.error}</p>
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          delay={QUEUE_PREVIEW_DELAY_MS}
          // Focusable so keyboard users can open the full text too.
          render={
            <span
              ref={previewRef}
              tabIndex={0}
              data-queue-preview=""
              className="min-w-0 flex-1 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {preview}
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="block max-w-md">
          <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{body}</div>
        </TooltipContent>
      </Tooltip>
      {state === "editing" && (
        <span className="shrink-0 text-xs text-muted-foreground">{t(($) => $.queue.editing)}</span>
      )}
      {attachmentCount > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
          title={t(($) => $.queue.attachments, { count: attachmentCount })}
        >
          <Paperclip className="size-3" aria-hidden="true" />
          {attachmentCount}
        </span>
      )}
      {state === "failed" || state === "unconfirmed" ? (
        <HintedButton hint={archivedHint} onClick={onRetry} label={t(($) => $.queue.retry_label, { position })}>
          {t(($) => $.queue.retry)}
        </HintedButton>
      ) : row.kind === "server" ? (
        <HintedButton
          hint={archivedHint}
          disabled={busy || state === "editing"}
          onClick={onSteer}
          label={t(($) => $.queue.send_now_label, { position })}
          tooltip={t(($) => $.queue.send_now_tooltip)}
        >
          {t(($) => $.queue.send_now)}
        </HintedButton>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              aria-label={t(($) => $.queue.more_label, { position })}
              title={t(($) => $.queue.more)}
            />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          finalFocus={() => {
            const moved = focusMovesAway.current;
            focusMovesAway.current = false;
            return !moved;
          }}
        >
          <DropdownMenuItem
            disabled={editDisabled}
            onClick={() => {
              focusMovesAway.current = true;
              onEdit();
            }}
          >
            <Pencil />
            {t(($) => $.queue.edit)}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => {
              focusMovesAway.current = true;
              onDelete();
            }}
          >
            <Trash2 />
            {t(($) => $.queue.delete)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
