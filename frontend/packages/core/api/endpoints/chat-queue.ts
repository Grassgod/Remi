import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import {
  EnqueueQueuedMessageResponseSchema,
  QueuedMessageItemResponseSchema,
  ResumeQueueResponseSchema,
  SessionQueueSchema,
  SteerQueuedMessageResponseSchema,
  type ChatQueue,
  type EnqueueQueuedMessageResponse,
  type QueuedChatMessage,
  type ResumeQueueResponse,
  type SteerQueuedMessageResponse,
} from "../schemas/chat-queue";

export interface EnqueueChatMessageInput {
  body_md: string;
  attachment_ids?: string[];
  /** Makes the enqueue idempotent: the same id returns the original row. */
  client_id: string;
}

export interface UpdateQueuedChatMessageInput {
  body_md: string;
  attachment_ids?: string[];
  expected_revision?: number;
}

/** `/api/sessions/:sessionId/queue`: the Chat follow-up queue (ADR 0020). */
export class ChatQueueEndpoints {
  constructor(readonly http: HttpClient) {}

  private base(sessionId: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/queue`;
  }

  private item(sessionId: string, itemId: string): string {
    return `${this.base(sessionId)}/${encodeURIComponent(itemId)}`;
  }

  /** A command must answer for the row it was sent for. */
  private sameItem(path: string, item: QueuedChatMessage, itemId: string): void {
    if (item.id !== itemId) throw new ApiContractError(path, "Server returned a different queued message");
  }

  async getChatQueue(sessionId: string): Promise<ChatQueue> {
    const path = this.base(sessionId);
    return parseStrictResponse<ChatQueue>(await this.http.fetch<unknown>(path), SessionQueueSchema, { endpoint: "GET /api/sessions/:id/queue" });
  }

  async enqueueChatMessage(sessionId: string, input: EnqueueChatMessageInput): Promise<EnqueueQueuedMessageResponse> {
    const path = this.base(sessionId);
    const body = {
      body_md: input.body_md,
      ...(input.attachment_ids?.length ? { attachment_ids: input.attachment_ids } : {}),
      client_id: input.client_id,
    };
    const result = parseStrictResponse<EnqueueQueuedMessageResponse>(
      await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }),
      EnqueueQueuedMessageResponseSchema, { endpoint: "POST /api/sessions/:id/queue" },
    );
    if (result.item.client_id !== input.client_id) throw new ApiContractError(path, "Server returned a different queued message");
    return result;
  }

  async updateQueuedChatMessage(sessionId: string, itemId: string, input: UpdateQueuedChatMessageInput): Promise<QueuedChatMessage> {
    const path = this.item(sessionId, itemId);
    const body = {
      body_md: input.body_md,
      ...(input.attachment_ids ? { attachment_ids: input.attachment_ids } : {}),
      ...(input.expected_revision !== undefined ? { expected_revision: input.expected_revision } : {}),
    };
    const { item } = parseStrictResponse<{ item: QueuedChatMessage }>(
      await this.http.fetch<unknown>(path, { method: "PATCH", body: JSON.stringify(body) }),
      QueuedMessageItemResponseSchema, { endpoint: "PATCH /api/sessions/:id/queue/:qid" },
    );
    this.sameItem(path, item, itemId);
    return item;
  }

  async deleteQueuedChatMessage(sessionId: string, itemId: string): Promise<QueuedChatMessage> {
    const path = this.item(sessionId, itemId);
    const { item } = parseStrictResponse<{ item: QueuedChatMessage }>(
      await this.http.fetch<unknown>(path, { method: "DELETE" }),
      QueuedMessageItemResponseSchema, { endpoint: "DELETE /api/sessions/:id/queue/:qid" },
    );
    this.sameItem(path, item, itemId);
    return item;
  }

  async steerQueuedChatMessage(sessionId: string, itemId: string): Promise<SteerQueuedMessageResponse> {
    const path = `${this.item(sessionId, itemId)}/steer`;
    const result = parseStrictResponse<SteerQueuedMessageResponse>(
      await this.http.fetch<unknown>(path, { method: "POST", body: "{}" }),
      SteerQueuedMessageResponseSchema, { endpoint: "POST /api/sessions/:id/queue/:qid/steer" },
    );
    this.sameItem(path, result.item, itemId);
    return result;
  }

  async resumeChatQueue(sessionId: string): Promise<ResumeQueueResponse> {
    const path = `${this.base(sessionId)}/resume`;
    return parseStrictResponse<ResumeQueueResponse>(
      await this.http.fetch<unknown>(path, { method: "POST", body: "{}" }),
      ResumeQueueResponseSchema, { endpoint: "POST /api/sessions/:id/queue/resume" },
    );
  }
}
