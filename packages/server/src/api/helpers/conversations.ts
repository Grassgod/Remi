import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { denyCurrentUserWorkspaceAccess, loadChatSessionForCurrentUser, canCurrentUserAccessChatTask, canUserViewTaskMessages, createTaskAuthMemo } from "./auth-guards.js";
import { currentTaskAccessToken, currentWorkspaceMember, currentRequestUserId } from "../wire/context.js";
import type { SendMessageInput } from "@multiremi/contracts/unified-model.js";
import type { TaskVisibilitySubject, TaskAuthMemo } from "./auth-guards.js";

export function canAccessConversationTask(c: Context, store: MultiremiStore, task: TaskVisibilitySubject, memo?: TaskAuthMemo): boolean {
  if (task.chatSessionId) {
    const token = currentTaskAccessToken(c);
    if (token && store.getTurnForAttempt(task.id)?.current_attempt_id !== token.taskId) return false;
    return canCurrentUserAccessChatTask(c, store, task, memo);
  }
  return canUserViewTaskMessages(store, currentRequestUserId(c), task, memo);
}

/** Memo lives for one request and caches only this caller's source-task checks. */
export function conversationEntryVisibility(c: Context, store: MultiremiStore) {
  const memo = createTaskAuthMemo(), allowed = new Map<string, boolean>();
  return (entry: { kind: string; task_id: string | null; reply_to_id?: string | null; metadata: Record<string, any> }): boolean => {
    if (entry.kind !== "turn" && !entry.metadata.human_request && !entry.metadata.human_response) return true;
    const sourceId = entry.task_id ?? (entry.reply_to_id ? store.getMessage(entry.reply_to_id)?.task_id : null);
    if (!sourceId) return false;
    if (!allowed.has(sourceId)) {
      const turn = store.getTurn(sourceId) ?? store.getTurnForAttempt(sourceId);
      const task = turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
      allowed.set(sourceId, !!task && canAccessConversationTask(c, store, task, memo));
    }
    return allowed.get(sourceId)!;
  };
}

export function loadConversation(c: Context, store: MultiremiStore, id: string) {
  const session = store.getIssueSession(id);
  if (session) return denyCurrentUserWorkspaceAccess(c, store, session.workspaceId)
    ?? { id, workspaceId: session.workspaceId, issueId: session.issueId, chatId: null };
  if (id.startsWith("auto_orphan_inbox_")) {
    const workspaceId = id.slice("auto_orphan_inbox_".length);
    if (!store.getWorkspace(workspaceId) || !store.getConversationLogHead(id)) return c.json({ error: "conversation not found" }, 404);
    return denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? { id, workspaceId, issueId: null, chatId: null };
  }
  if (id.startsWith("auto_")) {
    const auto = store.getAutopilot(id.slice(5));
    if (!auto) return c.json({ error: "conversation not found" }, 404);
    return denyCurrentUserWorkspaceAccess(c, store, auto.workspaceId)
      ?? { id, workspaceId: auto.workspaceId, issueId: null, chatId: null };
  }
  const token = currentTaskAccessToken(c);
  if (token) {
    const task = token.taskId ? store.getTask(token.taskId) : null;
    if (!task || task.chatSessionId !== id || !canAccessConversationTask(c, store, task)) return c.json({ error: "not your chat session" }, 403);
    return { id, workspaceId: task.workspaceId, issueId: null, chatId: id };
  }
  const chat = loadChatSessionForCurrentUser(c, store, id);
  return chat instanceof Response ? chat
    : { id, workspaceId: chat.session.workspaceId, issueId: null, chatId: id };
}

export function messageActor(c: Context, store: MultiremiStore, workspaceId: string): SendMessageInput["sender"] | Response {
  const token = currentTaskAccessToken(c);
  if (token) {
    const agent = token.agentId ? store.getAgent(token.agentId) : null;
    if (!agent || agent.archivedAt || agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
    return { type: "agent", id: agent.id };
  }
  const member = currentWorkspaceMember(c, store, workspaceId);
  return member && !member.archivedAt ? { type: "member", id: member.id }
    : c.json({ error: "active workspace member required" }, 403);
}

export function messageResponse<T extends object>(message: T) {
  const { card_token_hash, card_token_recipient, card_token_consumed_at, ...publicMessage } = message as T & { card_token_hash?: unknown; card_token_recipient?: unknown; card_token_consumed_at?: unknown };
  return publicMessage as Omit<T, "card_token_hash" | "card_token_recipient" | "card_token_consumed_at">;
}
