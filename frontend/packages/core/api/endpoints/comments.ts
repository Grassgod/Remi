import { z } from "zod";
import { turnToTask } from "../turn-task";
import { MessagesEndpoints } from "./messages";
import { MessageResponseSchema, MessageReactionSchema, type Message } from "../schemas/messages";
import { parseStrictResponse } from "../schema";
import type {
  AssigneeFrequencyEntry,
  Comment,
  CreateIssueSessionRequest,
  IssueReaction,
  IssueSession,
  IssueSessionTask,
  Reaction,
  SessionParticipant,
  SessionResult,
  TimelineEntry,
  TimelinePage,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_ISSUE_SESSION,
  EMPTY_ISSUE_SESSIONS,
  EMPTY_SESSION_PARTICIPANTS,
  EMPTY_SESSION_RESULTS,
  IssueSessionListSchema,
  IssueSessionSchema,
  SessionParticipantListSchema,
  SessionParticipantSchema,
  SessionResultListSchema,
} from "../schemas/comments";
import {
  EMPTY_TIMELINE_ENTRIES,
  EMPTY_TIMELINE_PAGE,
  TimelineEntriesSchema,
  TimelinePageSchema,
} from "../schemas/timeline";

function messageComment(message: Message, issueId = ""): Comment {
  return { id: message.id, issue_id: issueId, issue_session_id: message.session_id,
    author_type: message.sender_type === "member" || message.sender_type === "agent" ? message.sender_type : "system", author_id: message.sender_id ?? "", task_id: message.task_id,
    content: message.body_md, type: "comment", parent_id: message.reply_to_id,
    created_at: message.created_at, updated_at: message.updated_at, resolved_at: message.resolved_at, resolved_by_type: message.resolved_by_type === "member" || message.resolved_by_type === "agent" ? message.resolved_by_type : message.resolved_by_type ? "system" : null, resolved_by_id: message.resolved_by_id, attachments: message.attachments, reactions: message.reactions };
}
export class CommentsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Comments
  async createComment(
    issueId: string,
    content: string,
    _type?: string,
    parentId?: string,
    attachmentIds?: string[],
    issueSessionId?: string,
  ): Promise<Comment> {
    const sessions = issueSessionId ? [] : await this.listIssueSessions(issueId);
    const sessionId = issueSessionId ?? sessions.find(session => session.is_default)?.id;
    if (!sessionId) throw new Error("Conversation not found");
    const result = await new MessagesEndpoints(this.http).sendMessage(sessionId, {
      body_md: content, message_kind: parentId ? "reply" : "request", reply_to_id: parentId,
      to: { type: "role", ref: "issue_owner" }, wake_requested: "now", attachment_ids: attachmentIds,
    });
    return messageComment(result.message, issueId);
  }

  async listTimeline(issueId: string, issueSessionId?: string): Promise<TimelineEntry[]> {
    const query = issueSessionId
      ? `?issue_session_id=${encodeURIComponent(issueSessionId)}`
      : "";
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${issueId}/timeline${query}`,
    );
    return parseWithFallback(raw, TimelineEntriesSchema, EMPTY_TIMELINE_ENTRIES, {
      endpoint: "GET /api/issues/:id/timeline",
    });
  }

  async listTimelinePage(
    issueId: string,
    params: { issueSessionId?: string; before?: string | null; limit?: number } = {},
  ): Promise<TimelinePage> {
    const query = new URLSearchParams({ limit: String(params.limit ?? 40) });
    if (params.issueSessionId) query.set("issue_session_id", params.issueSessionId);
    if (params.before) query.set("before", params.before);
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${issueId}/timeline?${query.toString()}`,
    );
    return parseWithFallback(raw, TimelinePageSchema, EMPTY_TIMELINE_PAGE, {
      endpoint: "GET /api/issues/:id/timeline?limit",
    });
  }

  async listIssueSessions(issueId: string): Promise<IssueSession[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/sessions`);
    return parseWithFallback(raw, IssueSessionListSchema, EMPTY_ISSUE_SESSIONS, {
      endpoint: "GET /api/issues/:id/sessions",
    });
  }

  async createIssueSession(issueId: string, input: CreateIssueSessionRequest): Promise<IssueSession> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseWithFallback(raw, IssueSessionSchema, EMPTY_ISSUE_SESSION, {
      endpoint: "POST /api/issues/:id/sessions",
    });
  }

  async listSessionParticipants(issueId: string, sessionId: string): Promise<SessionParticipant[]> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${issueId}/sessions/${sessionId}/participants`,
    );
    return parseWithFallback(raw, SessionParticipantListSchema, EMPTY_SESSION_PARTICIPANTS, {
      endpoint: "GET /api/issues/:id/sessions/:sessionId/participants",
    });
  }

  async addSessionParticipant(
    issueId: string,
    sessionId: string,
    participantType: "agent" | "member",
    participantId: string,
  ): Promise<SessionParticipant> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${issueId}/sessions/${sessionId}/participants`,
      {
        method: "POST",
        body: JSON.stringify({
          participant_type: participantType,
          participant_id: participantId,
        }),
      },
    );
    return parseWithFallback(raw, SessionParticipantSchema, {
      id: "",
      session_id: sessionId,
      participant_type: participantType,
      participant_id: participantId,
      role: "participant",
      status: "active",
      joined_at: "",
      updated_at: "",
    }, {
      endpoint: "POST /api/issues/:id/sessions/:sessionId/participants",
    });
  }

  async removeSessionParticipant(
    issueId: string,
    sessionId: string,
    participantType: "agent" | "member",
    participantId: string,
  ): Promise<void> {
    await this.http.fetch(
      `/api/issues/${issueId}/sessions/${sessionId}/participants/${participantType}/${participantId}`,
      { method: "DELETE" },
    );
  }

  async listSessionTasks(_issueId: string, sessionId: string): Promise<IssueSessionTask[]> {
    const tasks: IssueSessionTask[] = [];
    let cursor: string | undefined;
    do { const page = await new MessagesEndpoints(this.http).listTurns({ session_id: sessionId, cursor, limit: 100 });
      tasks.push(...page.turns.map(turn => ({ ...turnToTask(turn), issue_session_id: turn.session_id }))); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return tasks;
  }

  async listIssueSessionResults(issueId: string): Promise<SessionResult[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/session-results`);
    return parseWithFallback(raw, SessionResultListSchema, EMPTY_SESSION_RESULTS, {
      endpoint: "GET /api/issues/:id/session-results",
    });
  }

  async getAssigneeFrequency(): Promise<AssigneeFrequencyEntry[]> {
    return this.http.fetch("/api/assignee-frequency");
  }

  async updateComment(commentId: string, content: string, attachmentIds?: string[]): Promise<Comment> {
    const messages = new MessagesEndpoints(this.http);
    if (attachmentIds) {
      const current = await messages.getMessage(commentId);
      const ids = current.attachments.map(a => a.id).sort();
      if (JSON.stringify(ids) !== JSON.stringify([...attachmentIds].sort())) throw new Error("Message attachments cannot be changed after sending");
    }
    return messageComment(await messages.editMessage(commentId, content));
  }
  async deleteComment(commentId: string): Promise<void> {
    await new MessagesEndpoints(this.http).deleteMessage(commentId);
  }
  async resolveComment(commentId: string): Promise<Comment> { return this.setResolved(commentId, true); }
  async unresolveComment(commentId: string): Promise<Comment> { return this.setResolved(commentId, false); }
  async setResolved(commentId: string, resolved: boolean): Promise<Comment> {
    const path = `/api/messages/${encodeURIComponent(commentId)}/resolve`;
    const response = parseStrictResponse<z.infer<typeof MessageResponseSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify({ resolved }) }), MessageResponseSchema, { endpoint: path });
    return messageComment(response.message);
  }
  async addReaction(commentId: string, emoji: string): Promise<Reaction[]> { return this.messageReactions(commentId, emoji, false); }
  async removeReaction(commentId: string, emoji: string): Promise<Reaction[]> { return this.messageReactions(commentId, emoji, true); }
  async messageReactions(commentId: string, emoji: string, remove: boolean): Promise<Reaction[]> {
    const path = `/api/messages/${encodeURIComponent(commentId)}/reactions`;
    const raw = await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify({ emoji, remove }) });
    return parseStrictResponse<{ reactions: Reaction[] }>(raw, z.object({ reactions: z.array(MessageReactionSchema) }), { endpoint: path }).reactions;
  }

  async addIssueReaction(issueId: string, emoji: string): Promise<IssueReaction> {
    return this.http.fetch(`/api/issues/${issueId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
  }

  async removeIssueReaction(issueId: string, emoji: string): Promise<void> {
    await this.http.fetch(`/api/issues/${issueId}/reactions`, {
      method: "DELETE",
      body: JSON.stringify({ emoji }),
    });
  }
}
