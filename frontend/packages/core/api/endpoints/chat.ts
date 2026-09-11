import type {
  ChatMessage,
  ChatMessagesPage,
  ChatPendingTask,
  ChatSession,
  ChatQueuedTask,
  PendingChatTasksResponse,
  PrioritizeChatQueuedTaskResponse,
  SendChatMessageResponse,
  UpdateChatSessionInput,
} from "../../types";
import { type HttpClient, ApiError } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import {
  ChatSessionSchema, ChatSessionListSchema, ChatSessionUpdateResponseSchema, ChatQueuedTaskSchema,
  ChatPendingTaskSchema, SendChatMessageResponseSchema,
  PrioritizeChatQueuedTaskResponseSchema, PendingChatTasksResponseSchema,
  ChatNoContentSchema, ChatCancelledTaskSchema,
} from "../schemas/chat";

export class ChatEndpoints {
  constructor(readonly http: HttpClient) {}

  // Chat Sessions
  async listChatSessions(params?: { status?: string }): Promise<ChatSession[]> {
    const query = params?.status ? `?status=${params.status}` : "";
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions${query}`);
    return parseStrictResponse(raw, ChatSessionListSchema, { endpoint: "GET /api/chat/sessions" });
  }

  async getChatSession(id: string): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`);
    return parseStrictResponse(raw, ChatSessionSchema, { endpoint: "GET /api/chat/sessions/:id" });
  }

  async createChatSession(data: { agent_id: string; title?: string }): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, ChatSessionSchema, { endpoint: "POST /api/chat/sessions" });
  }

  async deleteChatSession(id: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, { method: "DELETE" });
    parseStrictResponse(raw, ChatNoContentSchema, { endpoint: "DELETE /api/chat/sessions/:id" });
  }

  async updateChatSession(id: string, data: UpdateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionUpdateResponseSchema, { endpoint: "PATCH /api/chat/sessions/:id" });
    if (session.id !== id || Object.entries(data).some(([field, value]) =>
      value !== undefined && session[field as keyof UpdateChatSessionInput] !== value)) {
      throw new ApiContractError("PATCH /api/chat/sessions/:id", "Server did not retain the requested session changes");
    }
    return session;
  }

  async listChatMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.http.fetch(`/api/chat/sessions/${sessionId}/messages`);
  }

  async listChatMessagesPage(
    sessionId: string,
    params: { before?: { created_at: string; id: string } | null; limit?: number } = {},
  ): Promise<ChatMessagesPage> {
    const limit = params.limit ?? 50;
    const query = new URLSearchParams({ limit: String(limit) });
    if (params.before) {
      query.set("before_created_at", params.before.created_at);
      query.set("before_id", params.before.id);
    }
    try {
      return await this.http.fetch(
        `/api/chat/sessions/${sessionId}/messages/page?${query.toString()}`,
      );
    } catch (err) {
      // Deployment-order compatibility: a backend deployed before this endpoint
      // existed returns 404 for the unknown route. Fall back to the legacy
      // full-list endpoint so chat never white-screens regardless of whether
      // the server or the client deploys first. Only the initial (cursorless)
      // page falls back — the legacy endpoint returns every message at once, so
      // the fallback page reports has_more: false and there is no follow-up
      // request to translate. A 404 on a cursor request is an unexpected state
      // and propagates instead of duplicating the whole list.
      if (err instanceof ApiError && err.status === 404 && !params.before) {
        const messages = await this.listChatMessages(sessionId);
        return { messages, limit, has_more: false, next_cursor: null };
      }
      throw err;
    }
  }

  async sendChatMessage(
    sessionId: string,
    content: string,
    attachmentIds?: string[],
  ): Promise<SendChatMessageResponse> {
    const body: { content: string; attachment_ids?: string[] } = { content };
    if (attachmentIds && attachmentIds.length > 0) {
      body.attachment_ids = attachmentIds;
    }
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return parseStrictResponse(raw, SendChatMessageResponseSchema, { endpoint: "POST /api/chat/sessions/:id/messages" });
  }

  async getPendingChatTask(sessionId: string): Promise<ChatPendingTask> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/pending-task`);
    return parseStrictResponse(raw, ChatPendingTaskSchema, { endpoint: "GET /api/chat/sessions/:id/pending-task" });
  }

  async listPendingChatTasks(): Promise<PendingChatTasksResponse> {
    const raw = await this.http.fetch<unknown>(`/api/chat/pending-tasks`);
    return parseStrictResponse(raw, PendingChatTasksResponseSchema, { endpoint: "GET /api/chat/pending-tasks" });
  }

  async markChatSessionRead(sessionId: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/read`, { method: "POST" });
    parseStrictResponse(raw, ChatNoContentSchema, { endpoint: "POST /api/chat/sessions/:id/read" });
  }

  async editQueuedChatMessage(sessionId: string, taskId: string, content: string): Promise<ChatQueuedTask> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/queue/${taskId}`, {
      method: "PATCH", body: JSON.stringify({ content }),
    });
    return parseStrictResponse(raw, ChatQueuedTaskSchema, { endpoint: "PATCH /api/chat/sessions/:id/queue/:taskId" });
  }

  async removeQueuedChatMessage(sessionId: string, taskId: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/queue/${taskId}`, { method: "DELETE" });
    parseStrictResponse(raw, ChatNoContentSchema, { endpoint: "DELETE /api/chat/sessions/:id/queue/:taskId" });
  }

  async clearChatQueue(sessionId: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/queue`, { method: "DELETE" });
    parseStrictResponse(raw, ChatNoContentSchema, { endpoint: "DELETE /api/chat/sessions/:id/queue" });
  }

  async prioritizeQueuedChatMessage(sessionId: string, taskId: string): Promise<PrioritizeChatQueuedTaskResponse> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${sessionId}/queue/${taskId}/prioritize`, { method: "POST" });
    return parseStrictResponse(raw, PrioritizeChatQueuedTaskResponseSchema, { endpoint: "POST /api/chat/sessions/:id/queue/:taskId/prioritize" });
  }

  async cancelTaskById(taskId: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    const task = parseStrictResponse<{ id: string }>(raw, ChatCancelledTaskSchema, { endpoint: "POST /api/tasks/:id/cancel" });
    if (task.id !== taskId) throw new ApiContractError("POST /api/tasks/:id/cancel", "Server returned a different task");
  }
}
