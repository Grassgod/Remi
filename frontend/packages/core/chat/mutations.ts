import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { chatKeys } from "./queries";
import { createLogger } from "../logger";
import { getCurrentWsId } from "../platform/workspace-storage";
import type { ChatSession, UpdateChatSessionInput } from "../types";
import { useChatStore } from "./index";
import { removeChatSessionFromCache, updateChatSessionInCache } from "./session-cache";

const logger = createLogger("chat.mut");

export function useCreateChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (data: { agent_id: string; title?: string }) => {
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

/** Renaming, pinning, archive and restore share the authoritative session response. */
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

function refreshChatQueue(qc: QueryClient, wsId: string, sessionId: string): void {
  void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
  void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
  void qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
  void qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
  void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
  void qc.invalidateQueries({ queryKey: chatKeys.session(wsId, sessionId) });
}

export function useUpdateChatQueuedTask() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, taskId, content }: { sessionId: string; taskId: string; content: string }) =>
      api.editQueuedChatMessage(sessionId, taskId, content),
    onSettled: (_data, _error, { sessionId }, context) => refreshChatQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

export function useRemoveChatQueuedTask() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      api.removeQueuedChatMessage(sessionId, taskId),
    onSettled: (_data, _error, { sessionId }, context) => refreshChatQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

export function useClearChatQueue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (sessionId: string) => api.clearChatQueue(sessionId),
    onSettled: (_data, _error, sessionId, context) => refreshChatQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}

export function usePrioritizeChatQueuedTask() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      api.prioritizeQueuedChatMessage(sessionId, taskId),
    onSettled: (_data, _error, { sessionId }, context) => refreshChatQueue(qc, context?.wsId ?? wsId, sessionId),
  });
}
