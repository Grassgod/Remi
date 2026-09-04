import type { InboxItem, InboxPage, InboxSummary } from "../../types";
import type { HttpClient } from "../http";

export class InboxEndpoints {
  constructor(readonly http: HttpClient) {}

  // Inbox
  async listInbox(): Promise<InboxItem[]> {
    return this.http.fetch("/api/inbox");
  }

  async listInboxPage(options: { limit?: number; cursor?: string | null } = {}): Promise<InboxPage> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.http.fetch(`/api/inbox/page${query}`);
  }

  async getInboxSummary(timezoneOffset = new Date().getTimezoneOffset()): Promise<InboxSummary> {
    return this.http.fetch(`/api/inbox/summary?timezone_offset=${timezoneOffset}`);
  }

  async markInboxRead(id: string): Promise<InboxItem> {
    return this.http.fetch(`/api/inbox/${id}/read`, { method: "POST" });
  }

  async archiveInbox(id: string): Promise<InboxItem> {
    return this.http.fetch(`/api/inbox/${id}/archive`, { method: "POST" });
  }

  async getUnreadInboxCount(): Promise<{ count: number }> {
    return this.http.fetch("/api/inbox/unread-count");
  }

  async markAllInboxRead(): Promise<{ count: number }> {
    return this.http.fetch("/api/inbox/mark-all-read", { method: "POST" });
  }

  async archiveAllInbox(): Promise<{ count: number }> {
    return this.http.fetch("/api/inbox/archive-all", { method: "POST" });
  }

  async archiveAllReadInbox(): Promise<{ count: number }> {
    return this.http.fetch("/api/inbox/archive-all-read", { method: "POST" });
  }

  async archiveCompletedInbox(): Promise<{ count: number }> {
    return this.http.fetch("/api/inbox/archive-completed", { method: "POST" });
  }
}
