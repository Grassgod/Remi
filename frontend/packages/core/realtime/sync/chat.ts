import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { createLogger } from "../../logger";
import { getCurrentWsId } from "../../platform/workspace-storage";
import { chatKeys } from "../../chat/queries";
import { removeChatSessionFromCache, updateChatSessionInCache } from "../../chat/session-cache";
import { useChatStore } from "../../chat";
import type {
  TaskQueuedPayload,
  TaskDispatchPayload,
  TaskRunningPayload,
  TaskWaitingLocalDirectoryPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskCancelledPayload,
  ChatDonePayload,
  ChatMessage,
  ChatPendingTask,
  TaskAwaitingHumanPayload,
  ChatMessagesPage,
  ChatSession,
} from "../../types";
import type { SyncContext, SyncModule } from "./types";

const chatWsLogger = createLogger("chat.ws");

function settleChatPendingTask(qc: QueryClient, sessionId: string, taskId: string): void {
  qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), old => {
    if (!old) return old;
    const queued = old.queued_tasks?.filter(task => task.task_id !== taskId);
    if (old.task_id !== taskId) return queued ? { ...old, queued_tasks: queued } : old;
    // Another device may have reprioritized the queue. Preserve its known
    // contents, but let the authoritative refetch choose the next head.
    return old.supports_queue ? { supports_queue: true, queued_tasks: queued ?? [] } : {};
  });
}

export function applyChatDoneToCache(
  qc: QueryClient,
  payload: ChatDonePayload,
) {
  const sessionId = payload.chat_session_id;
  const taskId = payload.task_id;
  const messageId = payload.message_id;
  const content = payload.content;
  if (messageId && content !== undefined) {
    const assistant: ChatMessage = {
      id: messageId,
      chat_session_id: sessionId,
      role: "assistant",
      content,
      task_id: taskId,
      created_at: payload.created_at ?? new Date().toISOString(),
      elapsed_ms: payload.elapsed_ms ?? null,
    };
    qc.setQueryData<ChatMessage[] | undefined>(
      chatKeys.messages(sessionId),
      (old) => {
        if (!old) return old; // first fetch will pick it up
        // Idempotent against reconnect replay.
        if (old.some((m) => m.id === messageId)) return old;
        return [...old, assistant];
      },
    );
    qc.setQueryData<InfiniteData<ChatMessagesPage> | undefined>(
      chatKeys.messagesPage(sessionId),
      (old) => patchLatestChatMessagePage(old, assistant),
    );
  }
  // The reply is persisted; advance only its matching queue head.
  settleChatPendingTask(qc, sessionId, taskId);
  // Authoritative refetch reconciles redaction / migrations / clients
  // that took the fallback branch above.
  qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
  qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
  qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
}

function patchLatestChatMessagePage(
  old: InfiniteData<ChatMessagesPage> | undefined,
  message: ChatMessage,
): InfiniteData<ChatMessagesPage> | undefined {
  if (!old?.pages.length) return old;
  const seen = old.pages.some((page) => page.messages.some((m) => m.id === message.id));
  if (seen) return old;
  return {
    ...old,
    pages: old.pages.map((page, index) => {
      if (index !== 0) return page;
      return {
        ...page,
        messages: [...page.messages, message],
      };
    }),
  };
}

/**
 * Chat / task events (global, survives ChatWindow unmount).
 *
 * Server state lives in Query cache. Only selection/draft cleanup after a
 * confirmed session deletion touches the client store.
 *
 * chat:message / chat:done / task:completed / task:failed invalidate
 * messages + pending-task so the DB remains authoritative.
 */
export function createChatHandlers({ qc }: SyncContext): SyncModule {
  // Helpers reused by chat lifecycle handlers.
  const invalidatePendingAggregate = () => {
    const id = getCurrentWsId();
    if (id) qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(id) });
  };
  const invalidateSessionLists = () => {
    const id = getCurrentWsId();
    if (id) qc.invalidateQueries({ queryKey: chatKeys.sessions(id) });
  };
  const invalidateSession = (sessionId: string) => {
    const id = getCurrentWsId();
    if (id) qc.invalidateQueries({ queryKey: chatKeys.session(id, sessionId) });
  };
  const invalidateQueue = (sessionId: string) => {
    qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
    qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
    qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
    invalidatePendingAggregate();
    invalidateSessionLists();
    invalidateSession(sessionId);
  };

  return {
    handlers: {
      "chat:message": (p) => {
        const payload = p as { chat_session_id: string };
        chatWsLogger.info("chat:message (global)", { chat_session_id: payload.chat_session_id });
        qc.invalidateQueries({ queryKey: chatKeys.messages(payload.chat_session_id) });
        qc.invalidateQueries({ queryKey: chatKeys.messagesPage(payload.chat_session_id) });
        qc.invalidateQueries({ queryKey: chatKeys.pendingTask(payload.chat_session_id) });
        invalidatePendingAggregate();
        invalidateSessionLists();
        invalidateSession(payload.chat_session_id);
      },

      "chat:queue_updated": (p) => {
        const payload = p as { chat_session_id: string };
        invalidateQueue(payload.chat_session_id);
      },

      "chat:done": (p) => {
        const payload = p as ChatDonePayload;
        chatWsLogger.info("chat:done (global)", {
          task_id: payload.task_id,
          chat_session_id: payload.chat_session_id,
          has_message: !!payload.message_id,
        });
        // Inline-insert the assistant message into the messages cache BEFORE
        // clearing pending-task. Both writes land in the same React render
        // tick, so ChatMessageList sees `pendingAlreadyPersisted === true`
        // and the live TimelineView unmounts only after AssistantMessage has
        // mounted — no flicker window. This applies TkDodo's "combine
        // setQueryData (active query) + invalidateQueries (others)" pattern
        // (https://tkdodo.eu/blog/using-web-sockets-with-react-query).
        //
        // Falls back to invalidate-only when the server omits the message
        // payload (older builds). Older clients hitting a newer server also
        // work: they ignore the extra fields and rely on the invalidate
        // below, which keeps the old behavior alive.
        applyChatDoneToCache(qc, payload);
        invalidatePendingAggregate();
        // Assistant message just landed → has_unread may have flipped to true.
        invalidateSessionLists();
        invalidateSession(payload.chat_session_id);
      },

      // Chat task lifecycle writethrough: keep `chatKeys.pendingTask(sessionId)`
      // synchronized with the server state machine via setQueryData rather than
      // invalidate-refetch. Same pattern as task:message — the WS payload
      // carries everything we need, and an HTTP roundtrip just to read what we
      // already know would add latency to every stage transition.
      //
      // task:queued is emitted by EnqueueChatTask. The optimistic seed in
      // chat-window.tsx may have already populated the cache with a temporary
      // id; this handler upgrades it without replacing a running queue head.
      "task:queued": (p) => {
        const payload = p as TaskQueuedPayload;
        if (!payload.chat_session_id) return;
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(payload.chat_session_id),
          (old) => {
            // A follow-up or replay must not replace an already running head.
            if (old?.task_id && !old.task_id.startsWith("optimistic-")) return old;
            return { ...(old ?? {}), task_id: payload.task_id, status: "queued" };
          },
        );
        qc.invalidateQueries({ queryKey: chatKeys.pendingTask(payload.chat_session_id) });
        invalidatePendingAggregate();
      },

      // task:dispatch fires when the daemon claims the queued task. The daemon
      // immediately follows with StartTask, so dispatched→running is sub-second.
      // We collapse that window by writing "running" directly — the pill jumps
      // from "Queued" straight to "Thinking", skipping a meaningless "Starting"
      // frame. Stage decision in TaskStatusPill maps "running" + empty
      // taskMessages → "Thinking · Ns".
      "task:dispatch": (p) => {
        const payload = p as TaskDispatchPayload;
        if (!payload.chat_session_id) return;
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(payload.chat_session_id),
          (old) => {
            if (!old || old.task_id !== payload.task_id) return old;
            return { ...old, status: "running" };
          },
        );
      },

      // task:running fires when the daemon transitions a previously-parked task
      // (waiting_local_directory) back into the run phase. The dispatch→running
      // path is collapsed in the handler above, so this handler exists mainly to
      // clear a stale `waiting_local_directory` pill — without it, the pill
      // would stay parked even after the daemon resumed work.
      "task:running": (p) => {
        const payload = p as TaskRunningPayload;
        if (!payload.chat_session_id) return;
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(payload.chat_session_id),
          (old) => {
            if (!old || old.task_id !== payload.task_id) return old;
            return { ...old, status: "running" };
          },
        );
        // awaiting_human → running means the request was resolved (respond or
        // timeout); refetch so pending cards flip to their settled state.
        void qc.invalidateQueries({ queryKey: chatKeys.humanRequests(payload.task_id) });
      },

      // task:waiting_local_directory fires when the daemon dequeues a task but
      // can't acquire the local_directory path lock — another task on this
      // daemon is in the same directory. Write the status so TaskStatusPill
      // can render the "Waiting for local directory" stage instead of pinning
      // a stale "Starting / Thinking" frame.
      "task:waiting_local_directory": (p) => {
        const payload = p as TaskWaitingLocalDirectoryPayload;
        if (!payload.chat_session_id) return;
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(payload.chat_session_id),
          (old) => {
            if (!old || old.task_id !== payload.task_id) return old;
            return { ...old, status: "waiting_local_directory" };
          },
        );
      },

      // task:awaiting_human fires when the agent paused on a permission prompt
      // or AskUserQuestion. Write the status for TaskStatusPill and refetch the
      // request list so HumanRequestDock renders the interactive card.
      "task:awaiting_human": (p) => {
        const payload = p as TaskAwaitingHumanPayload;
        void qc.invalidateQueries({ queryKey: chatKeys.humanRequests(payload.task_id) });
        if (!payload.chat_session_id) return;
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(payload.chat_session_id),
          (old) => {
            if (!old || old.task_id !== payload.task_id) return old;
            return { ...old, status: "awaiting_human" };
          },
        );
      },

      // Cancellation can target the head or a follow-up. Retain every other task.
      "task:cancelled": (p) => {
        const payload = p as TaskCancelledPayload;
        if (!payload.chat_session_id) return;
        chatWsLogger.info("task:cancelled (global, chat)", {
          task_id: payload.task_id,
          chat_session_id: payload.chat_session_id,
        });
        settleChatPendingTask(qc, payload.chat_session_id, payload.task_id);
        invalidateQueue(payload.chat_session_id);
      },

      "task:completed": (p) => {
        const payload = p as TaskCompletedPayload;
        if (!payload.chat_session_id) return; // issue tasks handled elsewhere
        chatWsLogger.info("task:completed (global, chat)", {
          task_id: payload.task_id,
          chat_session_id: payload.chat_session_id,
        });
        // chat:done writes the reply; reconcile the next head and the FAB aggregate.
        invalidatePendingAggregate();
        qc.invalidateQueries({ queryKey: chatKeys.pendingTask(payload.chat_session_id) });
      },

      "task:failed": (p) => {
        const payload = p as TaskFailedPayload;
        if (!payload.chat_session_id) return;
        chatWsLogger.warn("task:failed (global, chat)", {
          task_id: payload.task_id,
          chat_session_id: payload.chat_session_id,
        });
        // FailTask writes a failure chat_message (mirroring CompleteTask's
        // success message), so this path mirrors the task:completed handler:
        // clear the pending signal AND invalidate the messages list so the
        // failure bubble shows up without requiring a page refresh. Pre-#1823
        // this branch only flipped pending — the comment "No new message"
        // was true then, but FailTask now persists a row.
        settleChatPendingTask(qc, payload.chat_session_id, payload.task_id);
        invalidateQueue(payload.chat_session_id);
      },

      "chat:session_read": (p) => {
        const payload = p as { chat_session_id: string };
        chatWsLogger.info("chat:session_read (global)", payload);
        invalidateSessionLists();
        invalidateSession(payload.chat_session_id);
      },

      // Rename, archive and pin changes update every cached list and detail.
      "chat:session_updated": (p) => {
        const payload = p as {
          chat_session_id: string;
          title?: string;
          updated_at?: string;
          status?: ChatSession["status"];
          pinned?: boolean;
        };
        chatWsLogger.info("chat:session_updated (global)", {
          chat_session_id: payload.chat_session_id,
          titleLength: payload.title?.length,
          status: payload.status,
          pinned: payload.pinned,
        });
        const id = getCurrentWsId();
        if (!id) return;
        const patch = (session: ChatSession): ChatSession => ({
          ...session,
          title: payload.title ?? session.title,
          updated_at: payload.updated_at ?? session.updated_at,
          status: payload.status ?? session.status,
          pinned: payload.pinned ?? session.pinned,
        });
        const cached = qc.getQueryData<ChatSession>(chatKeys.session(id, payload.chat_session_id))
          ?? qc.getQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(id) })
            .flatMap(([, sessions]) => sessions ?? [])
            .find(session => session.id === payload.chat_session_id);
        if (cached) updateChatSessionInCache(qc, id, patch(cached));
        invalidateSessionLists();
        invalidateSession(payload.chat_session_id);
      },

      // A confirmed hard delete removes cached history and the selected draft.
      "chat:session_deleted": (p) => {
        const payload = p as { chat_session_id: string };
        chatWsLogger.info("chat:session_deleted (global)", payload);
        const id = getCurrentWsId();
        if (id) {
          removeChatSessionFromCache(qc, id, payload.chat_session_id);
        }
        invalidatePendingAggregate();

        const chatState = useChatStore.getState?.();
        chatState?.clearInputDraft(payload.chat_session_id);
        if (chatState && chatState.activeSessionId === payload.chat_session_id) {
          chatState.setActiveSession(null);
        }
      },
    },
  };
}
