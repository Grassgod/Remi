"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  commit: () => void;
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
  onReleased,
}: {
  sessionId: string;
  /** The running turn; its changes refresh the queue and drive the stalled banner. */
  pendingTaskId: string | null;
  /** A row became a log message; the caller refreshes the conversation. */
  onReleased?: () => void;
}) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const query = useQuery(chatQueueOptions(wsId, sessionId));
  const serverItems = useMemo(() => query.data?.items ?? [], [query.data]);
  const paused = query.data?.paused ?? null;
  const outbox = useChatStore((s) => s.queueOutbox[sessionId] ?? EMPTY_OUTBOX);
  const queueEdit = useChatStore((s) => s.queueEdit[sessionId]);
  const isRunning = !!pendingTaskId;

  const steer = useSteerQueuedChatMessage();
  const remove = useDeleteQueuedChatMessage();
  const resume = useResumeChatQueue();
  const enqueue = useEnqueueChatMessage();

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
  // placeholders are skipped: only the server's turn identity matters.
  const lastTaskRef = useRef(pendingTaskId);
  useEffect(() => {
    if (pendingTaskId?.startsWith("optimistic-") || lastTaskRef.current === pendingTaskId) return;
    lastTaskRef.current = pendingTaskId;
    void qc.invalidateQueries({ queryKey: chatKeys.queue(wsId, sessionId) });
  }, [pendingTaskId, qc, wsId, sessionId]);

  // Client-only state: rows hidden behind an undo toast, and server rows whose
  // steer failed without an HTTP answer.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const pendingDeletes = useRef(new Map<string, PendingDelete>());
  const mounted = useRef(true);

  const setMember = (set: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> => {
    if (set.has(key) === present) return set;
    const next = new Set(set);
    if (present) next.add(key);
    else next.delete(key);
    return next;
  };

  const flushDelete = useCallback((key: string) => {
    const pending = pendingDeletes.current.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.current.delete(key);
    pending.commit();
  }, []);

  // Leaving the chat (unmount or a session switch, which remounts this list)
  // sends every delete still waiting behind its undo toast.
  useEffect(() => {
    mounted.current = true;
    const deletes = pendingDeletes.current;
    return () => {
      mounted.current = false;
      for (const [key, pending] of [...deletes]) {
        toast.dismiss(pending.toastId);
        flushDelete(key);
      }
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
    // A row released (or deleted elsewhere) before its undo ran out needs no DELETE.
    for (const [key, pending] of [...pendingDeletes.current]) {
      if (key.startsWith("server:") && !serverIds.has(key.slice("server:".length))) {
        clearTimeout(pending.timer);
        toast.dismiss(pending.toastId);
        pendingDeletes.current.delete(key);
      }
    }
    setHidden((current) => {
      const next = [...current].filter((key) => !key.startsWith("server:") || serverIds.has(key.slice("server:".length)));
      return next.length === current.size ? current : new Set(next);
    });
    setUnconfirmed((current) => {
      const next = [...current].filter((id) => serverIds.has(id));
      return next.length === current.size ? current : new Set(next);
    });
  }, [query.data, outbox, serverIds, serverClientIds, sessionId]);

  // The row being edited left the queue (the turn released it, or another tab
  // deleted it): keep the edited text as an ordinary draft.
  useEffect(() => {
    if (!queueEdit || !query.isSuccess || query.isFetching || serverIds.has(queueEdit.itemId)) return;
    useChatStore.getState().finishQueueEdit(sessionId, "keep");
    toast(t(($) => $.queue.consumed));
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
  // missed (for example the Chat was archived mid-run). Offer Resume after a
  // grace period so a turn that just ended can release its rows first.
  const stalledCandidate = !paused && !isRunning && !query.isFetching
    && rows.some((row) => row.kind === "server" && row.item.status === "queued");
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!stalledCandidate) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), QUEUE_STALLED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [stalledCandidate]);

  const failed = () => toast.error(t(($) => $.queue.failed));

  const runResume = () => {
    resume.mutate({ sessionId }, {
      onSuccess: (result) => { if (result.released.length) onReleased?.(); },
      onError: failed,
    });
  };

  const runSteer = (item: QueuedChatMessage) => {
    setUnconfirmed((current) => setMember(current, item.id, false));
    steer.mutate({ sessionId, itemId: item.id }, {
      onSuccess: () => onReleased?.(),
      onError: (error) => {
        if (isQueueConsumed(error)) toast(t(($) => $.queue.consumed));
        else if (isQueueDeliveryUnconfirmed(error)) setUnconfirmed((current) => setMember(current, item.id, true));
        // A failed release is written into the row (failed, lane paused).
        else if (!queueErrorItem(error)) failed();
      },
    });
  };

  const retryEnqueue = (item: ChatQueueOutboxItem) => {
    enqueue.mutate({
      sessionId, body_md: item.body_md, attachment_ids: item.attachment_ids, attachments: item.attachments,
      client_id: item.client_id, created_at: item.created_at,
    }, {
      onSuccess: (result) => { if (result.released) onReleased?.(); },
      // A row deleted elsewhere just leaves the list; other refusals are explained.
      onError: (error) => {
        if (!isQueueDeliveryUnconfirmed(error) && queueErrorCode(error) !== "queued_message_deleted") failed();
      },
    });
  };

  const startEdit = (row: Row) => {
    const store = useChatStore.getState();
    if (row.kind === "server") {
      store.startQueueEdit(sessionId, {
        itemId: row.item.id, revision: row.item.revision, body_md: row.item.body_md,
        attachments: queuedAttachmentBindings(row.item.body_md, row.item.attachments),
      });
      return;
    }
    // Without a server row there is nothing to save to: the text goes back
    // into the composer as an ordinary draft.
    const current = store.inputDrafts[sessionId]?.trim() ?? "";
    store.setInputDraft(sessionId, [current, row.item.body_md].filter(Boolean).join("\n\n"));
    for (const [url, id] of Object.entries(queuedAttachmentBindings(row.item.body_md, row.item.attachments))) {
      store.setInputDraftAttachment(sessionId, url, id);
    }
    store.removeQueueOutboxItem(sessionId, row.item.client_id);
  };

  const scheduleDelete = (row: Row) => {
    const key = row.key;
    if (pendingDeletes.current.has(key)) return;
    if (row.kind === "server" && queueEdit?.itemId === row.item.id) {
      useChatStore.getState().finishQueueEdit(sessionId, "restore");
    }
    const commit = row.kind === "server"
      ? () => {
          remove.mutateAsync({ sessionId, itemId: row.item.id }).catch((error: unknown) => {
            if (mounted.current) setHidden((current) => setMember(current, key, false));
            if (isQueueConsumed(error)) toast(t(($) => $.queue.consumed));
            else failed();
          });
        }
      : () => {
          useChatStore.getState().removeQueueOutboxItem(sessionId, row.item.client_id);
          if (mounted.current) setHidden((current) => setMember(current, key, false));
        };
    setHidden((current) => setMember(current, key, true));
    const toastId = toast(t(($) => $.queue.deleted), {
      duration: QUEUE_DELETE_UNDO_MS,
      action: {
        label: t(($) => $.queue.undo),
        onClick: () => {
          const pending = pendingDeletes.current.get(key);
          if (!pending) return;
          clearTimeout(pending.timer);
          pendingDeletes.current.delete(key);
          if (mounted.current) setHidden((current) => setMember(current, key, false));
        },
      },
    });
    const timer = setTimeout(() => flushDelete(key), QUEUE_DELETE_UNDO_MS);
    pendingDeletes.current.set(key, { timer, toastId, commit });
  };

  if (!rows.length) return null;

  const banner = paused?.reason === "interrupted" ? t(($) => $.queue.interrupted)
    : paused?.reason === "turn_ended" ? t(($) => $.queue.turn_ended)
      : paused && paused.reason !== "send_failed" ? t(($) => $.queue.stalled)
        : stalled ? t(($) => $.queue.stalled) : null;

  return (
    <div className="shrink-0 px-5">
      <section
        aria-label={t(($) => $.queue.title)}
        data-chat-queue=""
        className="mx-auto mb-2 max-h-[30dvh] w-full max-w-4xl overflow-y-auto rounded-lg border bg-card text-sm"
      >
        {banner && (
          <div role="status" className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <CirclePause className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{banner}</span>
            <Button variant="ghost" size="xs" disabled={resume.isPending} onClick={runResume}>
              {t(($) => $.queue.resume)}
            </Button>
          </div>
        )}
        <ul className="divide-y">
          {rows.map((row, index) => (
            <QueueRow
              key={row.key}
              row={row}
              position={index + 1}
              onSteer={() => row.kind === "server" && runSteer(row.item)}
              onRetry={() => {
                if (row.kind === "outbox") retryEnqueue(row.item);
                else if (row.state === "unconfirmed") runSteer(row.item);
                else runResume();
              }}
              onEdit={() => startEdit(row)}
              onDelete={() => scheduleDelete(row)}
              editDisabled={row.kind === "outbox" && !!queueEdit}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function QueueRow({
  row,
  position,
  onSteer,
  onRetry,
  onEdit,
  onDelete,
  editDisabled,
}: {
  row: Row;
  position: number;
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
  const more = t(($) => $.queue.more);
  // Editing hands focus to the composer; the menu must not take it back.
  const editing = useRef(false);

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
        <TooltipTrigger delay={QUEUE_PREVIEW_DELAY_MS} render={<span className="min-w-0 flex-1 truncate" />}>
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
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onRetry}>
          {t(($) => $.queue.retry)}
        </Button>
      ) : row.kind === "server" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="xs" className="shrink-0" disabled={busy || state === "editing"} onClick={onSteer} />
            }
          >
            {t(($) => $.queue.send_now)}
          </TooltipTrigger>
          <TooltipContent side="top">{t(($) => $.queue.send_now_tooltip)}</TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label={more} title={more} />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          finalFocus={() => {
            const keepComposerFocus = editing.current;
            editing.current = false;
            return !keepComposerFocus;
          }}
        >
          <DropdownMenuItem
            disabled={editDisabled || state === "editing"}
            onClick={() => {
              editing.current = true;
              onEdit();
            }}
          >
            <Pencil />
            {t(($) => $.queue.edit)}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={busy} onClick={onDelete}>
            <Trash2 />
            {t(($) => $.queue.delete)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
