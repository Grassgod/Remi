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
  const memo = createTaskAuthMemo(), allowed = new Map<string, boolean>(), decisions = new Map<string, boolean>();
  return (entry: ConversationVisibilityEntry): boolean => {
    const decision = conversationEntryDecision(entry,
      id => store.getMessage(id),
      seq => entry.session_id ? store.getConversationLogEntry(entry.session_id, seq) : null);
    if (decision === null) return false;
    if (decision) {
      if (!decision.id) return false;
      if (!decisions.has(decision.id)) {
        const session = store.getIssueSession(decision.session_id ?? "");
        decisions.set(decision.id, !!session && !!store.getIssueDecision(session.issueId, decision.id));
      }
      if (!decisions.get(decision.id)) return false;
    }
    const sourceId = conversationEntrySource(entry,
      id => store.getMessage(id),
      seq => entry.session_id ? store.getConversationLogEntry(entry.session_id, seq) : null);
    if (sourceId === undefined) return true;
    if (!sourceId) return false;
    if (!allowed.has(sourceId)) {
      const turn = store.getTurn(sourceId) ?? store.getTurnForAttempt(sourceId);
      const task = turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
      allowed.set(sourceId, !!task && canAccessConversationTask(c, store, task, memo));
    }
    return allowed.get(sourceId)!;
  };
}

export interface ConversationVisibilityEntry {
  id?: string;
  kind: string;
  task_id: string | null;
  session_id?: string;
  reply_to_id?: string | null;
  parent_id?: string | null;
  metadata: Record<string, any>;
}

/** Replies and mutation markers inherit the Issue decision's relation checks. */
export function conversationEntryDecision(
  entry: ConversationVisibilityEntry,
  reply: (id: string) => ConversationVisibilityEntry | null | undefined,
  target: (seq: number) => ConversationVisibilityEntry | null | undefined,
  depth = 0,
): ConversationVisibilityEntry | null | undefined {
  if (depth > 4) return null;
  if (entry.metadata.decision_record?.source_issue_id || entry.metadata.source_issue_id) return entry;
  if (!entry.metadata.human_response && !Number.isSafeInteger(entry.metadata.target_seq)
    && typeof entry.metadata.message_id !== "string") return undefined;
  const replyId = entry.reply_to_id ?? entry.parent_id
    ?? (typeof entry.metadata.message_id === "string" ? entry.metadata.message_id : null);
  const related = Number.isSafeInteger(entry.metadata.target_seq) ? target(entry.metadata.target_seq)
    : replyId ? reply(replyId) : null;
  return related ? conversationEntryDecision(related, reply, target, depth + 1) : undefined;
}

/** undefined is unrestricted; null is a protected row with no resolvable source. */
export function conversationEntrySource(
  entry: ConversationVisibilityEntry,
  reply: (id: string) => ConversationVisibilityEntry | null | undefined,
  target: (seq: number) => ConversationVisibilityEntry | null | undefined,
  depth = 0,
): string | null | undefined {
  if (depth > 4) return null;
  if (entry.kind === "turn" || entry.metadata.human_request) {
    const replyId = entry.reply_to_id ?? entry.parent_id;
    return entry.task_id ?? (replyId ? reply(replyId)?.task_id : null) ?? null;
  }
  if (entry.metadata.human_response) {
    const replyId = entry.reply_to_id ?? entry.parent_id;
    const question = replyId ? reply(replyId) : null;
    const source = entry.task_id ?? question?.task_id;
    if (source) return source;
    // Ordinary decision replies also carry human_response. Inherit the
    // question's visibility; missing or unresolved protected sources stay hidden.
    return question ? conversationEntrySource(question, reply, target, depth + 1) : null;
  }
  // Edit/delete and lifecycle markers can contain the protected row's body.
  if (Number.isSafeInteger(entry.metadata.target_seq)) {
    const row = target(entry.metadata.target_seq);
    return row ? conversationEntrySource(row, reply, target, depth + 1) : null;
  }
  if (typeof entry.metadata.message_id === "string") {
    const row = reply(entry.metadata.message_id);
    return row ? conversationEntrySource(row, reply, target, depth + 1) : null;
  }
  return undefined;
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
  return stripCardTokenFields(message) as Omit<T, "card_token_hash" | "card_token_recipient" | "card_token_consumed_at">;
}

export function stripCardTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCardTokenFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("card_token_"))
    .map(([key, nested]) => [key, stripCardTokenFields(nested)]));
}
