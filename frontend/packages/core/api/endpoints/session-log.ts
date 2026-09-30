import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { SessionLogLocationSchema, SessionLogWindowSchema, type LogWindowParams, type SessionLogWindow } from "../schemas/session-log";

export class SessionLogEndpoints {
  constructor(readonly http: HttpClient) {}

  async getSessionLog(sessionId: string, params: LogWindowParams = {}): Promise<SessionLogWindow> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/log${query.size ? `?${query}` : ""}`;
    return parseStrictResponse(await this.http.fetch<unknown>(path), SessionLogWindowSchema, { endpoint: "getSessionLog" });
  }

  async locateSessionLogEntry(sessionId: string, id: string): Promise<{ id: string; seq: number; head_seq: number }> {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/log/locate?id=${encodeURIComponent(id)}`;
    return parseStrictResponse(await this.http.fetch<unknown>(path), SessionLogLocationSchema, { endpoint: "locateSessionLogEntry" });
  }
}
