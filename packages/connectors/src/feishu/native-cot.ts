import type * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";

export interface CotHandle { cotId: string; messageId: string }
export interface CotEvent { event_type: string; content: string; timestamp: string }
export type CotSample = [type: string, content: Record<string, unknown>];

/** The API limits each JSON-encoded event to 4096 characters, 50 per write.
 * Use a byte limit too, so astral characters and JSON escapes are safe. */
export function cotTextEvents(id: string, text: string, reasoning = false): CotSample[] {
  if (!text) return [];
  const prefix = reasoning ? "REASONING_MESSAGE" : "TEXT_MESSAGE";
  const events: CotSample[] = [[`${prefix}_START`, { messageId: id, role: reasoning ? "reasoning" : "assistant" }]];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(JSON.stringify({ messageId: id, delta: chunk + char })) > 3900) {
      events.push([`${prefix}_CONTENT`, { messageId: id, delta: chunk }]);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) events.push([`${prefix}_CONTENT`, { messageId: id, delta: chunk }]);
  events.push([`${prefix}_END`, { messageId: id }]);
  return events;
}

export function feishuResponseError(operation: string, response: { code?: number; msg?: string }): FeishuDeliveryError {
  // Only known temporary failures are retried. Content/permission/argument
  // rejections are terminal; retrying the same payload cannot fix them.
  const retryable = response.code === 99991400 || response.code === 99991401 || response.code === 99991500;
  return new FeishuDeliveryError(`${operation}: Feishu code ${response.code ?? "missing"}`, retryable);
}

export function feishuTransportError(operation: string, error: unknown): FeishuDeliveryError {
  if (error instanceof FeishuDeliveryError) return error;
  const e = error as { response?: { status?: number; data?: { code?: number; msg?: string } } };
  if (e?.response?.data?.code) return feishuResponseError(operation, e.response.data);
  const status = e?.response?.status;
  if (status && status < 500) return new FeishuDeliveryError(`${operation}: HTTP ${status}`, status === 429);
  // No response / 5xx may mean that the write committed. Do not blindly retry
  // a non-idempotent native CoT create or append.
  return new FeishuDeliveryError(`${operation}: response unavailable`, true, true);
}

/** Native message_cot, using the same client's bot token and domain as IM. */
export class FeishuCotTransport {
  constructor(private readonly client: Lark.Client) {}

  async create(chatId: string, originMessageId?: string): Promise<CotHandle> {
    const data = await this.request("POST", {
      receive_id: chatId,
      ...(originMessageId ? { origin_message_id: originMessageId } : {}),
    });
    if (typeof data?.cot_id !== "string" || !data.cot_id || typeof data.message_id !== "string" || !data.message_id) {
      throw new FeishuDeliveryError("CoT create: incomplete acknowledgement", false, true);
    }
    return { cotId: data.cot_id, messageId: data.message_id };
  }

  async write(handle: CotHandle, events: CotEvent[]): Promise<void> {
    if (!events.length || events.length > 50) throw new Error("CoT writes require 1–50 events");
    for (const event of events) {
      if (Buffer.byteLength(event.content) > 4096 || !/^\d+$/.test(event.timestamp)) throw new Error("Invalid CoT event");
    }
    await this.request("PUT", { cot_id: handle.cotId, message_id: handle.messageId, events });
  }

  /** RUN_ERROR alone does not close the native process spinner. */
  async complete(handle: CotHandle, reason: "done" | "error" | "timeout"): Promise<void> {
    try {
      const response = await this.client.request<{ code?: number; msg?: string }>({
        method: "POST", url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(handle.cotId)}`,
        params: { message_id: handle.messageId, reason },
      });
      if (response.code !== 0) throw feishuResponseError("CoT complete", response);
    } catch (error) { throw feishuTransportError("CoT complete", error); }
  }

  private async request(method: "POST" | "PUT", data: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.client.request<{ code?: number; msg?: string; data?: Record<string, unknown> }>({
        method, url: "/open-apis/im/v1/message_cot",
        ...(method === "POST" ? { params: { receive_id_type: "chat_id" } } : {}), data,
      });
      if (response.code !== 0) throw feishuResponseError(`CoT ${method}`, response);
      return response.data;
    } catch (error) {
      throw feishuTransportError(`CoT ${method}`, error);
    }
  }
}
