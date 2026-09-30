import type {
  CreateChatSessionInput,
  ChatPendingTask,
  ChatSession,
  ChatQueuedTask,
  PendingChatTasksResponse,
  PrioritizeChatQueuedTaskResponse,
  SendChatMessageResponse,
  UpdateChatSessionInput,
} from "../../types";
import type { HttpClient } from "../http";
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

  async createChatSession(data: CreateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionSchema, { endpoint: "POST /api/chat/sessions" });
    if (data.runtime_workspace_id && session.runtime_workspace_id !== data.runtime_workspace_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected runtime workspace");
    }
    if (data.project_id && session.project_id !== data.project_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected project");
    }
    return session;
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

  async sendChatMessage(
    sessionId: string,
    content: string,
    attachmentIds?: string[],
    clientId?: string,
  ): Promise<SendChatMessageResponse> {
    const body: { content: string; attachment_ids?: string[]; client_id?: string } = { content };
    if (attachmentIds && attachmentIds.length > 0) {
      body.attachment_ids = attachmentIds;
    }
    if (clientId) body.client_id = clientId;
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
