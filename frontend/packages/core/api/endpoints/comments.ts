import type {
  AssigneeFrequencyEntry,
  Comment,
  CreateIssueSessionRequest,
  IssueReaction,
  IssueSession,
  IssueSessionTask,
  Reaction,
  SessionEvent,
  SessionParticipant,
  SessionResult,
  TimelineEntry,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  CommentsListSchema,
  EMPTY_ISSUE_SESSION,
  EMPTY_ISSUE_SESSIONS,
  EMPTY_ISSUE_SESSION_TASKS,
  EMPTY_SESSION_EVENTS,
  EMPTY_SESSION_PARTICIPANTS,
  EMPTY_SESSION_RESULTS,
  IssueSessionListSchema,
  IssueSessionSchema,
  IssueSessionTaskListSchema,
  SessionEventListSchema,
  SessionParticipantListSchema,
  SessionParticipantSchema,
  SessionResultListSchema,
} from "../schemas/comments";
import { EMPTY_TIMELINE_ENTRIES, TimelineEntriesSchema } from "../schemas/timeline";

export class CommentsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Comments
  async listComments(issueId: string): Promise<Comment[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/comments`);
    return parseWithFallback(raw, CommentsListSchema, [], {
      endpoint: "GET /api/issues/:id/comments",
    });
  }

  async createComment(
    issueId: string,
    content: string,
    type?: string,
    parentId?: string,
    attachmentIds?: string[],
    issueSessionId?: string,
  ): Promise<Comment> {
    return this.http.fetch(issueSessionId
      ? `/api/issues/${issueId}/sessions/${issueSessionId}/messages`
      : `/api/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content,
        type: type ?? "comment",
        ...(parentId ? { parent_id: parentId } : {}),
        ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
      }),
    });
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

  async listSessionEvents(issueId: string, sessionId: string): Promise<SessionEvent[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/sessions/${sessionId}/events`);
    return parseWithFallback(raw, SessionEventListSchema, EMPTY_SESSION_EVENTS, {
      endpoint: "GET /api/issues/:id/sessions/:sessionId/events",
    });
  }

  async listSessionTasks(issueId: string, sessionId: string): Promise<IssueSessionTask[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${issueId}/sessions/${sessionId}/tasks`);
    return parseWithFallback(raw, IssueSessionTaskListSchema, EMPTY_ISSUE_SESSION_TASKS, {
      endpoint: "GET /api/issues/:id/sessions/:sessionId/tasks",
    });
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
    return this.http.fetch(`/api/comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify({ content, attachment_ids: attachmentIds }),
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.http.fetch(`/api/comments/${commentId}`, { method: "DELETE" });
  }

  async resolveComment(commentId: string): Promise<Comment> {
    return this.http.fetch(`/api/comments/${commentId}/resolve`, { method: "POST" });
  }

  async unresolveComment(commentId: string): Promise<Comment> {
    return this.http.fetch(`/api/comments/${commentId}/resolve`, { method: "DELETE" });
  }

  async addReaction(commentId: string, emoji: string): Promise<Reaction> {
    return this.http.fetch(`/api/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
  }

  async removeReaction(commentId: string, emoji: string): Promise<void> {
    await this.http.fetch(`/api/comments/${commentId}/reactions`, {
      method: "DELETE",
      body: JSON.stringify({ emoji }),
    });
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
