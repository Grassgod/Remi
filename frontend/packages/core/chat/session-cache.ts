import type { QueryClient } from "@tanstack/react-query";
import type { ChatSession } from "../types";
import { chatKeys } from "./queries";

export function updateChatSessionInCache(qc: QueryClient, wsId: string, session: ChatSession): void {
  for (const [key, previous] of qc.getQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(wsId) })) {
    if (!previous) continue;
    const status = key[3];
    const origin = key[4] ?? "user";
    const next = previous.filter(item => item.id !== session.id);
    const statusMatches = !status || status === "all" || status === session.status;
    const originMatches = origin === "all" || (origin === "automation") === (session.origin !== null);
    if (statusMatches && originMatches) next.push(session);
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
