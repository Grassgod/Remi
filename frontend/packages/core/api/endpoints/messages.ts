import type { z } from "zod";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import { MessageResponseSchema, MessagesPageSchema, SendMessageResponseSchema, TurnDetailSchema, TurnsPageSchema, type SendMessageBody } from "../schemas/messages";

export class MessagesEndpoints {
  constructor(readonly http: HttpClient) {}
  private messageResult(id: string, raw: unknown, path: string) {
    const result = parseStrictResponse<z.infer<typeof MessageResponseSchema>>(raw, MessageResponseSchema, { endpoint: path }).message;
    if (result.id !== id) throw new ApiContractError(path, "Server returned a different message");
    return result;
  }
  async listMessages(sessionId: string, options: { limit?: number; cursor?: string; unread_by?: string; message_kind?: string; thread?: string } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages${params.size ? `?${params}` : ""}`;
    return parseStrictResponse<z.infer<typeof MessagesPageSchema>>(await this.http.fetch<unknown>(path), MessagesPageSchema, { endpoint: path });
  }
  async sendMessage(sessionId: string, body: SendMessageBody) {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
    return parseStrictResponse<z.infer<typeof SendMessageResponseSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }), SendMessageResponseSchema, { endpoint: path });
  }
  async getMessage(id: string) {
    const path = `/api/messages/${encodeURIComponent(id)}`;
    return this.messageResult(id, await this.http.fetch<unknown>(path), path);
  }
  async editMessage(id: string, body_md: string) {
    const path = `/api/messages/${encodeURIComponent(id)}`;
    return this.messageResult(id, await this.http.fetch<unknown>(path, { method: "PATCH", body: JSON.stringify({ body_md }) }), path);
  }
  async deleteMessage(id: string) {
    const path = `/api/messages/${encodeURIComponent(id)}`;
    return this.messageResult(id, await this.http.fetch<unknown>(path, { method: "DELETE" }), path);
  }
  async listTurns(options: { session_id?: string; issue?: string; status?: string; limit?: number; cursor?: string } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
    const path = `/api/turns${params.size ? `?${params}` : ""}`;
    return parseStrictResponse<z.infer<typeof TurnsPageSchema>>(await this.http.fetch<unknown>(path), TurnsPageSchema, { endpoint: path });
  }
  async getTurn(id: string, attempts = false) {
    const path = `/api/turns/${encodeURIComponent(id)}${attempts ? "?attempts=true" : ""}`;
    return parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path), TurnDetailSchema, { endpoint: path });
  }
  async getTurnInput(id: string) {
    const path = `/api/turns/${encodeURIComponent(id)}?input=true`;
    const detail = parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path), TurnDetailSchema, { endpoint: path });
    return detail.input ? { ...detail.input, prompt: detail.input.legacy_prompt ?? detail.input.messages.map(message => message.body_md).join("\n\n") } : null;
  }
  async controlTurn(id: string, operation: "cancel" | "wrap-up") {
    const path = `/api/turns/${encodeURIComponent(id)}/${operation}`;
    return parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: "{}" }), TurnDetailSchema, { endpoint: path });
  }
  async retryTurn(id: string, cold = false) {
    const path = `/api/turns/${encodeURIComponent(id)}/retry`;
    const result = parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify({ cold }) }), TurnDetailSchema, { endpoint: path });
    if (result.turn.id !== id) throw new ApiContractError(path, "Server returned a different turn");
    return result;
  }
}
