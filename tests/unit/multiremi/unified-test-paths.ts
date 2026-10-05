import type { MultiremiStore } from "@multiremi/store.js";
import type { Database } from "bun:sqlite";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";

// Resolve fixture identities before making a real canonical HTTP request.
// These helpers do not dispatch requests, translate responses or synthesize
// successful statuses; behavioral assertions stay in the calling tests.
export function issueMessagesPath(store: MultiremiStore, issueRef: string): string {
  const issue = store.getIssueByRef(issueRef);
  const session = issue ? store.getOrCreateDefaultIssueSession(issue.id).id : issueRef;
  return `/api/sessions/${session}/messages`;
}

export function turnApiPath(store: MultiremiStore, attemptId: string, suffix = ""): string {
  return `/api/turns/${store.getTurnForAttempt(store.getTaskByRef(attemptId)?.id ?? attemptId)?.id ?? attemptId}${suffix}`;
}

export function attemptMessagesPath(store: MultiremiStore, attemptId: string): string {
  return `/api/sessions/${store.getTurnForAttempt(attemptId)?.session_id ?? attemptId}/messages`;
}

export function attemptInputMessageId(store: MultiremiStore, attemptId: string): string {
  const turn = store.getTurnForAttempt(attemptId);
  return turn ? store.listMessages(turn.session_id, { from: turn.wake_seq - 1, to: turn.wake_seq })[0]?.id ?? attemptId : attemptId;
}

export function taskRequestPath(store: MultiremiStore, input: Record<string, any>): string {
  const session = input.chatSessionId ?? input.chat_session_id ?? input.issueSessionId ?? input.issue_session_id;
  if (session) return `/api/sessions/${session}/messages`;
  const issue = input.issueId ?? input.issue_id;
  if (issue) return issueMessagesPath(store, issue);
  const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
  const orphan = `auto_orphan_inbox_${workspaceId}`;
  // An orphan conversation is a fixture resource, like an Issue/Chat session.
  store.ensureSessionHeadWithinTransaction(orphan, { bodyMd: "" });
  return `/api/sessions/${orphan}/messages`;
}

export function requestMessageBody(store: MultiremiStore, input: Record<string, any>, fallbackTo?: Record<string, string>): Record<string, any> {
  const text = input.body_md ?? input.body ?? input.content ?? input.prompt ?? input.bodyMd ?? "";
  const mention = typeof text === "string" ? /mention:\/\/(agent|squad)\/([^\s)]+)/.exec(text) : null;
  const agentId = input.agentId ?? input.agent_id ?? (mention?.[1] === "agent" ? mention[2]
    : mention?.[1] === "squad" ? store.getSquad(mention[2]!)?.leaderId : null);
  const replyTo = input.reply_to_id ?? input.parent_id ?? input.parentId;
  return { ...input, body_md: text, message_kind: input.message_kind ?? (replyTo ? "reply" : "request"),
    to: input.to ?? (agentId ? { type: "agent", ref: agentId } : fallbackTo ?? { type: "role", ref: input.chatSessionId || input.chat_session_id ? "relay" : "issue_owner" }),
    ...(replyTo ? { reply_to_id: replyTo } : {}),
    ...(input.attachmentIds ? { attachment_ids: input.attachmentIds } : {}) };
}

export function sentTask(store: MultiremiStore, result: { turn_id?: string }) {
  const turn = result.turn_id ? store.getTurn(result.turn_id) : null;
  if (!turn?.current_attempt_id) throw new Error("The message did not create or wake a turn");
  return store.getTask(turn.current_attempt_id)!;
}

export function mutateExecutionFixture(db: SqlDatabase | Database, sql: string, ...args: unknown[]) {
  return runTurnExecutionMutation(db as unknown as SqlDatabase, sql, ...args);
}
