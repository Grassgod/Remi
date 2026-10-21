import type { QueryClient } from "@tanstack/react-query";
import type { ChatSession, CreateChatSessionInput } from "../types";
import { chatKeys } from "./queries";

/** Whether the session list under `key` (a `chatKeys.sessionList`) shows `session`. */
export function sessionListHolds(key: readonly unknown[], session: Pick<ChatSession, "status" | "origin">): boolean {
  const status = key[3];
  const origin = key[4] ?? "user";
  const statusMatches = !status || status === "all" || status === session.status;
  const originMatches = origin === "all" || (origin === "automation") === (session.origin !== null);
  return statusMatches && originMatches;
}

export function updateChatSessionInCache(qc: QueryClient, wsId: string, session: ChatSession): void {
  for (const [key, previous] of qc.getQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(wsId) })) {
    if (!previous) continue;
    const next = previous.filter(item => item.id !== session.id);
    if (sessionListHolds(key, session)) next.push(session);
    next.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
    qc.setQueryData(key, next);
  }
  qc.setQueryData(chatKeys.session(wsId, session.id), session);
}

export function removeChatSessionFromCache(qc: QueryClient, wsId: string, sessionId: string): void {
  qc.setQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(wsId) },
    previous => previous?.filter(session => session.id !== sessionId));
  qc.removeQueries({ queryKey: chatKeys.session(wsId, sessionId) });
  qc.removeQueries({ queryKey: chatKeys.pendingTask(sessionId) });
}

/**
 * The record of a chat created under a client-made id, shown in the lists and
 * the header until the server's answer replaces it.
 */
export function optimisticChatSession(
  wsId: string,
  input: CreateChatSessionInput & { id: string },
  creatorId: string,
  now = new Date().toISOString(),
): ChatSession {
  return {
    id: input.id, workspace_id: wsId, agent_id: input.agent_id, creator_id: creatorId,
    project_id: input.project_id ?? null, runtime_workspace_id: input.runtime_workspace_id ?? null,
    title: input.title?.trim() ?? "", status: "active", has_unread: false, pinned: false, origin: null,
    unread_count: 0, last_message: null, running_background_tasks: 0, created_at: now, updated_at: now,
  };
}
