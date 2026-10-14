import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { toSafeErrorDetails } from "../api/http";
import type { UpdateQueuedChatMessageInput } from "../api/endpoints/chat-queue";
import type { ChatQueue, QueuedMessageAttachment } from "../api/schemas/chat-queue";
import { useWorkspaceId } from "../hooks";
import { chatKeys } from "./queries";
import { createLogger } from "../logger";
import { getCurrentSlug, getCurrentWsId } from "../platform/workspace-storage";
import type { ChatSession, CreateChatSessionInput, UpdateChatSessionInput } from "../types";
import { useChatStore } from "./index";
import { removeChatSessionFromCache, updateChatSessionInCache } from "./session-cache";
import { applyQueueItem, isQueueDeliveryUnconfirmed, queueErrorItem } from "./queue";

const logger = createLogger("chat.mut");

export function useCreateChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (data: CreateChatSessionInput) => {
      logger.info("createChatSession.start", { agent_id: data.agent_id, titleLength: data.title?.length ?? 0 });
      return api.createChatSession(data);
    },
    onSuccess: (session, _data, { wsId }) => {
      qc.setQueryData<ChatSession[]>(chatKeys.sessions(wsId), previous => previous ?? []);
      updateChatSessionInCache(qc, wsId, session);
      logger.info("createChatSession.success", { sessionId: session.id, agentId: session.agent_id });
    },
    onError: (err) => logger.error("createChatSession.error", err),
    onSettled: (_data, _error, _variables, context) => qc.invalidateQueries({ queryKey: chatKeys.sessions(context?.wsId ?? wsId) }),
  });
}

/** Read badges change only after the server acknowledges the command. */
export function useMarkChatSessionRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (sessionId: string) => api.markChatSessionRead(sessionId),
    onSuccess: (_data, sessionId, { wsId }) => {
      qc.setQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(wsId) }, old =>
        old?.map(session => session.id === sessionId ? { ...session, has_unread: false, unread_count: 0 } : session));
      qc.setQueryData<ChatSession>(chatKeys.session(wsId, sessionId), old =>
        old ? { ...old, has_unread: false, unread_count: 0 } : old);
    },
    onError: (err, sessionId) => logger.error("markChatSessionRead.error", { sessionId, err }),
    onSettled: (_data, _err, sessionId, context) => {
      const wsId = context?.wsId;
      if (!wsId) return;
      void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
      void qc.invalidateQueries({ queryKey: chatKeys.session(wsId, sessionId) });
    },
  });
}

/** Session settings share the authoritative session response. */
export function useUpdateChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, ...data }: UpdateChatSessionInput & { sessionId: string }) =>
      api.updateChatSession(sessionId, data),
    onSuccess: (session, _data, { wsId }) => updateChatSessionInCache(qc, wsId, session),
    onError: (err, vars) => logger.error("updateChatSession.error", { sessionId: vars.sessionId, err }),
    onSettled: (_data, _err, { sessionId }, context) => {
      const wsId = context?.wsId;
      if (!wsId) return;
      void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
      void qc.invalidateQueries({ queryKey: chatKeys.session(wsId, sessionId) });
    },
  });
}

/** A failed deletion must retain the selected conversation and its draft. */
export function useDeleteChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (sessionId: string) => api.deleteChatSession(sessionId),
    onSuccess: (_data, sessionId, { wsId }) => {
      removeChatSessionFromCache(qc, wsId, sessionId);
      // A request may finish after navigation; leave the new workspace store intact.
      if (getCurrentWsId() !== wsId) return;
      const state = useChatStore.getState?.();
      state?.clearInputDraft(sessionId);
      state?.clearQueueState(sessionId);
      if (state?.activeSessionId === sessionId) state.setActiveSession(null);
    },
    onError: (err, sessionId) => logger.error("deleteChatSession.error", { sessionId, err }),
    onSettled: (_data, _error, _variables, context) => {
      const wsId = context?.wsId;
      if (!wsId) return;
      void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Follow-up queue (ADR 0020)
//
// Row commands are keyed under CHAT_QUEUE_MUTATION_KEY with `{sessionId,
// itemId}` variables so the queue list can show a row as sending from
// `useMutationState`, whichever component started the command. The server
// emits `chat:queue_updated` for every change; the handlers below only write
// the authoritative answer early and refetch the queue.
//
// `networkMode: "always"` sends them even when the browser reports offline:
// a paused command would hang instead of failing into "unconfirmed".
// ---------------------------------------------------------------------------

export const CHAT_QUEUE_MUTATION_KEY = ["chat-queue"] as const;

export interface EnqueueChatMessageVariables {
  sessionId: string;
  body_md: string;
  attachment_ids?: string[];
  /** Display details for the local row until the server answers. */
  attachments: QueuedMessageAttachment[];
  client_id: string;
  created_at: string;
}

export interface QueuedChatMessageVariables {
  sessionId: string;
  itemId: string;
}

function refreshQueue(qc: QueryClient, wsId: string, sessionId: string): void {
  void qc.invalidateQueries({ queryKey: chatKeys.queue(wsId, sessionId) });
}

/** A release created or joined a turn; the running state follows. */
function refreshAfterRelease(qc: QueryClient, wsId: string, sessionId: string): void {
  void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
  void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
  void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
}

/**
 * Queues a message. The local row lives in the chat store's outbox until the
 * server answers: a refusal with a status removes it (the composer keeps the
 * draft); a failure without one leaves it `unconfirmed` for the user to retry
 * with the same `client_id` or delete. An idle lane releases the row at once;
 * the caller refreshes the log when `released` comes back.
 */
export function useEnqueueChatMessage() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: [...CHAT_QUEUE_MUTATION_KEY, "enqueue"],
    networkMode: "always",
    onMutate: (vars: EnqueueChatMessageVariables) => {
      useChatStore.getState().putQueueOutboxItem(vars.sessionId, {
        client_id: vars.client_id, body_md: vars.body_md, attachment_ids: vars.attachment_ids,
        attachments: vars.attachments, created_at: vars.created_at, state: "sending",
      });
      return { wsId, slug: getCurrentSlug() };
    },
    mutationFn: (vars: EnqueueChatMessageVariables) => api.enqueueChatMessage(vars.sessionId, {
      body_md: vars.body_md, attachment_ids: vars.attachment_ids, client_id: vars.client_id,
    }),
    onSuccess: (result, vars, context) => {
      qc.setQueryData<ChatQueue>(chatKeys.queue(context.wsId, vars.sessionId), (old) => applyQueueItem(old, result.item));
      // After a workspace switch the item leaves that workspace's stored outbox.
      useChatStore.getState().removeQueueOutboxItem(vars.sessionId, vars.client_id, context.slug);
      if (result.released) refreshAfterRelease(qc, context.wsId, vars.sessionId);
    },
    onError: (error, vars, context) => {
      logger.error("enqueueChatMessage.error", { sessionId: vars.sessionId, error: toSafeErrorDetails(error) });
      const store = useChatStore.getState();
      if (!isQueueDeliveryUnconfirmed(error)) {
        store.removeQueueOutboxItem(vars.sessionId, vars.client_id, context?.slug);
        return;
      }
      // Another workspace's stored outbox already reads the item back as unconfirmed.
      if (context && getCurrentWsId() !== context.wsId) return;
      store.putQueueOutboxItem(vars.sessionId, {
        client_id: vars.client_id, body_md: vars.body_md, attachment_ids: vars.attachment_ids,
        attachments: vars.attachments, created_at: vars.created_at, state: "unconfirmed",
      });
    },
    onSettled: (_data, _error, vars, context) => refreshQueue(qc, context?.wsId ?? wsId, vars.sessionId),
  });
}

/** Saves an edited row; `expected_revision` refuses a row changed elsewhere. */
export function useUpdateQueuedChatMessage() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: [...CHAT_QUEUE_MUTATION_KEY, "update"],
    networkMode: "always",
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, itemId, ...input }: QueuedChatMessageVariables & UpdateQueuedChatMessageInput) =>
      api.updateQueuedChatMessage(sessionId, itemId, input),
    onSuccess: (item, { sessionId }, { wsId }) => {
      qc.setQueryData<ChatQueue>(chatKeys.queue(wsId, sessionId), (old) => applyQueueItem(old, item));
    },
    onError: (error, { sessionId }) => logger.error("updateQueuedChatMessage.error", { sessionId, error: toSafeErrorDetails(error) }),
    onSettled: (_data, _error, { sessionId }, context) => refreshQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

export function useDeleteQueuedChatMessage() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: [...CHAT_QUEUE_MUTATION_KEY, "delete"],
    networkMode: "always",
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, itemId }: QueuedChatMessageVariables) => api.deleteQueuedChatMessage(sessionId, itemId),
    onSuccess: (item, { sessionId }, { wsId }) => {
      qc.setQueryData<ChatQueue>(chatKeys.queue(wsId, sessionId), (old) => applyQueueItem(old, item));
    },
    onError: (error, { sessionId }) => logger.error("deleteQueuedChatMessage.error", { sessionId, error: toSafeErrorDetails(error) }),
    onSettled: (_data, _error, { sessionId }, context) => refreshQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

/**
 * Releases one row now (引导): it becomes an ordinary now message, which the
 * running turn takes as a steer. A failed release answers 409 with the
 * failed row, written into the cache so the row shows why.
 */
export function useSteerQueuedChatMessage() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: [...CHAT_QUEUE_MUTATION_KEY, "steer"],
    networkMode: "always",
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, itemId }: QueuedChatMessageVariables) => api.steerQueuedChatMessage(sessionId, itemId),
    onSuccess: (result, { sessionId }, { wsId }) => {
      qc.setQueryData<ChatQueue>(chatKeys.queue(wsId, sessionId), (old) => applyQueueItem(old, result.item));
      refreshAfterRelease(qc, wsId, sessionId);
    },
    onError: (error, { sessionId }, context) => {
      logger.error("steerQueuedChatMessage.error", { sessionId, error: toSafeErrorDetails(error) });
      const failed = queueErrorItem(error);
      if (failed && context) qc.setQueryData<ChatQueue>(chatKeys.queue(context.wsId, sessionId), (old) => applyQueueItem(old, failed));
    },
    onSettled: (_data, _error, { sessionId }, context) => refreshQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

/** Clears the pause, retries failed rows and releases the queue if the lane is idle. */
export function useResumeChatQueue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: [...CHAT_QUEUE_MUTATION_KEY, "resume"],
    networkMode: "always",
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId }: { sessionId: string }) => api.resumeChatQueue(sessionId),
    onSuccess: (result, { sessionId }, { wsId }) => {
      qc.setQueryData<ChatQueue>(chatKeys.queue(wsId, sessionId), { items: result.items, paused: result.paused });
      if (result.released.length) refreshAfterRelease(qc, wsId, sessionId);
    },
    onError: (error, { sessionId }) => logger.error("resumeChatQueue.error", { sessionId, error: toSafeErrorDetails(error) }),
    onSettled: (_data, _error, { sessionId }, context) => refreshQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}
