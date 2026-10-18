import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { denyCurrentUserWorkspaceAccess, loadChatSessionForCurrentUser, canCurrentUserAccessChatTask, canUserViewTaskMessages, createTaskAuthMemo } from "./auth-guards.js";
import { currentTaskAccessToken, currentWorkspaceMember, currentRequestUserId, hasVerifiedRequestIdentity } from "../wire/context.js";
import type { SendMessageInput } from "@multiremi/contracts/unified-model.js";
import type { MultiremiChatSession, MultiremiIssueSession } from "@multiremi/contracts/types.js";
import type { TaskVisibilitySubject, TaskAuthMemo } from "./auth-guards.js";

export function canAccessConversationTask(c: Context, store: MultiremiStore, task: TaskVisibilitySubject, memo?: TaskAuthMemo): boolean {
  if (task.chatSessionId) {
    const token = currentTaskAccessToken(c);
    if (token && task.id !== token.taskId) return false;
    return canCurrentUserAccessChatTask(c, store, task, memo);
  }
  return canUserViewTaskMessages(store, currentRequestUserId(c), task, memo);
}

export interface ConversationVisibilityOptions {
  /**
   * Entries the predicate is about to check, e.g. one log window. Their related
   * messages and source subjects are read up front in bounded batches. Ids the
   * batch did not cover use the per-entry reads, so every decision is the same.
   */
  prefetch?: readonly ConversationVisibilityEntry[];
  /** The Chat the request's conversation guard already loaded, seeded into the memo. */
  chatSession?: MultiremiChatSession | null;
}

/** Related-message walks stop past this depth (see the walkers below). */
const RELATED_MESSAGE_MAX_DEPTH = 4;

/** Message ids the walkers below may pass to `reply` for this entry. */
function relatedMessageIds(entry: ConversationVisibilityEntry): string[] {
  return [entry.reply_to_id ?? entry.parent_id, entry.metadata.message_id, entry.metadata.root_question_id]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Batch the reads {@link conversationEntryVisibility} would issue per entry:
 * related messages level by level (`store.getMessages`, the batched
 * `getMessage`), then the source subjects of every source those messages
 * resolve (`store.getConversationSourceSubjects`, the batched
 * turn → current attempt → task lookup). Only results are cached; the access
 * decision itself still runs per source, lazily, in the predicate.
 */
function prefetchConversationVisibility(store: MultiremiStore, entries: readonly ConversationVisibilityEntry[],
  related: Map<string, ConversationVisibilityEntry | null>, subjects: Map<string, TaskVisibilitySubject | null>): void {
  let frontier: readonly ConversationVisibilityEntry[] = entries;
  for (let depth = 0; depth <= RELATED_MESSAGE_MAX_DEPTH && frontier.length; depth++) {
    const ids = [...new Set(frontier.flatMap(relatedMessageIds))].filter(id => !related.has(id));
    if (!ids.length) break;
    const found = store.getMessages(ids);
    for (const id of ids) related.set(id, found.get(id) ?? null);
    frontier = ids.map(id => related.get(id)).filter((row): row is ConversationVisibilityEntry => !!row);
  }
  // Resolve candidate sources from prefetched rows only; a source reached
  // through an unfetched row (a `target_seq` marker, or a walk deeper than the
  // prefetch) is absent and takes the per-entry path.
  const sources = new Set<string>();
  for (const entry of entries) {
    const source = conversationEntrySource(entry, id => related.get(id) ?? null, () => null);
    if (source) sources.add(source);
  }
  if (sources.size) for (const [id, subject] of store.getConversationSourceSubjects([...sources])) subjects.set(id, subject);
}

/** Memo lives for one request and caches only this caller's source-task checks. */
export function conversationEntryVisibility(c: Context, store: MultiremiStore, options: ConversationVisibilityOptions = {}) {
  const memo = createTaskAuthMemo(), allowed = new Map<string, boolean>(), decisions = new Map<string, boolean>();
  const notifications = new Map<string, boolean>();
  if (options.chatSession) memo.chatSessions.set(options.chatSession.id, options.chatSession);
  const related = new Map<string, ConversationVisibilityEntry | null>();
  const subjects = new Map<string, TaskVisibilitySubject | null>();
  if (options.prefetch?.length) prefetchConversationVisibility(store, options.prefetch, related, subjects);
  // A prefetched id answers from the batch (null when it has no message row);
  // any other id is read exactly as before.
  const reply = (id: string): ConversationVisibilityEntry | null => related.has(id) ? related.get(id) ?? null : store.getMessage(id);
  return (entry: ConversationVisibilityEntry): boolean => {
    const target = (seq: number) => entry.session_id ? store.getConversationLogEntry(entry.session_id, seq) : null;
    const notification = conversationEntryQuestionNotification(entry, reply, target);
    if (notification === null) return false;
    if (notification) {
      if (!notification.id) return false;
      if (!notifications.has(notification.id)) notifications.set(notification.id, store.canReadQuestionNotification(notification.id,
        { userId: currentRequestUserId(c), admin: false, attemptId: currentTaskAccessToken(c)?.taskId ?? undefined }));
      return notifications.get(notification.id)!;
    }
    const decision = conversationEntryDecision(entry, reply, target);
    if (decision === null) return false;
    if (decision) {
      if (!decision.id) return false;
      if (!decisions.has(decision.id)) {
        const session = store.getIssueSession(decision.session_id ?? "");
        decisions.set(decision.id, !!session && !!store.getIssueDecision(session.issueId, decision.id));
      }
      if (!decisions.get(decision.id)) return false;
    }
    const sourceId = conversationEntrySource(entry, reply, target);
    if (sourceId === undefined) return true;
    if (!sourceId) return false;
    if (!allowed.has(sourceId)) {
      const task = subjects.has(sourceId) ? subjects.get(sourceId)! : conversationSourceTask(store, sourceId);
      allowed.set(sourceId, !!task && canAccessConversationTask(c, store, task, memo));
    }
    return allowed.get(sourceId)!;
  };
}

/** The per-source lookup that `store.getConversationSourceSubjects` batches. */
function conversationSourceTask(store: MultiremiStore, sourceId: string): TaskVisibilitySubject | null {
  const turn = store.getTurn(sourceId) ?? store.getTurnForAttempt(sourceId);
  return turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
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

/** Related edits and replies cannot reveal a notification hidden from this caller. */
export function conversationEntryQuestionNotification(
  entry: ConversationVisibilityEntry,
  reply: (id: string) => ConversationVisibilityEntry | null | undefined,
  target: (seq: number) => ConversationVisibilityEntry | null | undefined,
  depth = 0,
): ConversationVisibilityEntry | null | undefined {
  if (depth > 4) return null;
  if (entry.metadata.question_notification === true || entry.metadata.question_present_request === true) return entry;
  const replyId = entry.reply_to_id ?? entry.parent_id
    ?? (typeof entry.metadata.message_id === 'string' ? entry.metadata.message_id : null);
  const related = Number.isSafeInteger(entry.metadata.target_seq) ? target(entry.metadata.target_seq)
    : replyId ? reply(replyId) : null;
  return related ? conversationEntryQuestionNotification(related, reply, target, depth + 1) : undefined;
}

/** Replies and mutation markers inherit the Issue decision's relation checks. */
export function conversationEntryDecision(
  entry: ConversationVisibilityEntry,
  reply: (id: string) => ConversationVisibilityEntry | null | undefined,
  target: (seq: number) => ConversationVisibilityEntry | null | undefined,
  depth = 0,
): ConversationVisibilityEntry | null | undefined {
  if (depth > 4) return null;
  if (entry.metadata.question_source_notification === true) {
    const original = typeof entry.metadata.root_question_id === 'string' ? reply(entry.metadata.root_question_id) : null;
    return original ? conversationEntryDecision(original, reply, target, depth + 1) : null;
  }
  if (entry.metadata.decision_record?.source_issue_id || entry.metadata.source_issue_id) return entry;
  if (!entry.metadata.human_response && !entry.metadata.decision_answer && !Number.isSafeInteger(entry.metadata.target_seq)
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
  if (entry.metadata.question_source_notification === true) {
    const original = typeof entry.metadata.root_question_id === 'string' ? reply(entry.metadata.root_question_id) : null;
    return original ? conversationEntrySource(original, reply, target, depth + 1) : null;
  }
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

export interface LoadedConversation {
  id: string;
  workspaceId: string;
  issueId: string | null;
  chatId: string | null;
  /** The Issue session or Chat row the guard read, so a route need not read it again. */
  issueSession?: MultiremiIssueSession;
  chatSession?: MultiremiChatSession;
}

export function loadConversation(c: Context, store: MultiremiStore, id: string): LoadedConversation | Response {
  const session = store.getIssueSession(id);
  if (session) {
    const issue = store.getIssue(session.issueId);
    if (!issue) return c.json({ error: "conversation not found" }, 404);
    return denyCurrentUserWorkspaceAccess(c, store, session.workspaceId)
      ?? { id, workspaceId: session.workspaceId, issueId: session.issueId, chatId: null, issueSession: session };
  }
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
    const chat = store.getChatSession(id);
    const denied = chat && denyCurrentUserWorkspaceAccess(c, store, chat.workspaceId);
    if (denied) return denied;
    // Task credentials never inherit the runtime owner's creator permissions.
    if (!task || task.chatSessionId !== id) return c.json({ error: "not your chat session" }, 403);
    if (!chat) return c.json({ error: "chat session not found" }, 404);
    // Feishu Chat creators differ from runtime owners; authorize the bound Task.
    if (task.workspaceId !== chat.workspaceId || token.workspaceId !== chat.workspaceId)
      return c.json({ error: "not your chat session" }, 403);
    return { id, workspaceId: chat.workspaceId, issueId: null, chatId: id, chatSession: chat };
  }
  const chat = loadChatSessionForCurrentUser(c, store, id);
  return chat instanceof Response ? chat
    : { id, workspaceId: chat.session.workspaceId, issueId: null, chatId: id, chatSession: chat.session };
}

export function messageActor(c: Context, store: MultiremiStore, workspaceId: string): SendMessageInput["sender"] | Response {
  const token = currentTaskAccessToken(c);
  if (token) {
    const agent = token.agentId ? store.getAgent(token.agentId) : null;
    if (!agent || agent.archivedAt || agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
    return { type: "agent", id: agent.id };
  }
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (!member && !hasVerifiedRequestIdentity(c)) return { type: "platform", id: null };
  return member && !member.archivedAt ? { type: "member", id: member.id }
    : c.json({ error: "active workspace member required" }, 403);
}

export function messageResponse<T extends object>(message: T) {
  return stripCardTokenFields(message) as Omit<T, "card_token_hash" | "card_token_recipient" | "card_token_consumed_at">;
}

export function stripCardTokenFields(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => stripCardTokenFields(item, path));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("card_token_")
    && !(key === 'wait_id' && (path.at(-1) === 'metadata' || path.at(-1) === 'wait' && path.at(-2) === 'question'))
    && !(key === 'runtime_id' && path.at(-1) === 'wait' && path.at(-2) === 'question'))
    .map(([key, nested]) => [key, stripCardTokenFields(nested, [...path, key])]));
}
