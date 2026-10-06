import type { z } from "zod";
import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { MessageInboxSchema, ReadInboxSchema, ReadAllInboxSchema } from "../schemas/messages";

export class InboxEndpoints {
  constructor(readonly http: HttpClient) {}
  async listInboxPage(options: { workspace_id?: string; limit?: number; cursor?: string | null } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value != null) params.set(key, String(value));
    const path = `/api/inbox${params.size ? `?${params}` : ""}`;
    return parseStrictResponse<z.infer<typeof MessageInboxSchema>>(await this.http.fetch<unknown>(path), MessageInboxSchema, { endpoint: path });
  }
  async markInboxRead(input: { session_id: string; to_seq?: number }) {
    return parseStrictResponse<z.infer<typeof ReadInboxSchema>>(await this.http.fetch<unknown>("/api/inbox/read", { method: "POST", body: JSON.stringify(input) }), ReadInboxSchema, { endpoint: "POST /api/inbox/read" });
  }
  async markAllInboxRead() {
    return parseStrictResponse<z.infer<typeof ReadAllInboxSchema>>(await this.http.fetch<unknown>("/api/inbox/read", { method: "POST", body: JSON.stringify({ all: true }) }), ReadAllInboxSchema, { endpoint: "POST /api/inbox/read" });
  }
}
