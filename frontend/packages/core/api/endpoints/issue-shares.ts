import type { ManagedIssueShare, SharedIssueBundle, SharedTaskTracePage } from "../../types";
import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  EMPTY_MANAGED_ISSUE_SHARE_RESPONSE,
  EMPTY_SHARED_ISSUE_BUNDLE,
  ManagedIssueShareResponseSchema,
  SharedIssueBundleSchema,
  SharedTaskTracePageSchema,
} from "../schemas/issue-shares";

export class IssueSharesEndpoints {
  constructor(readonly http: HttpClient) {}

  async getIssueShare(issueId: string): Promise<ManagedIssueShare | null> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${encodeURIComponent(issueId)}/share`);
    return parseWithFallback(
      raw,
      ManagedIssueShareResponseSchema,
      EMPTY_MANAGED_ISSUE_SHARE_RESPONSE,
      { endpoint: "GET /api/issues/:id/share" },
    ).share;
  }

  async createIssueShare(issueId: string): Promise<ManagedIssueShare | null> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${encodeURIComponent(issueId)}/share`, {
      method: "POST",
    });
    return parseWithFallback(
      raw,
      ManagedIssueShareResponseSchema,
      EMPTY_MANAGED_ISSUE_SHARE_RESPONSE,
      { endpoint: "POST /api/issues/:id/share" },
    ).share;
  }

  async extendIssueShare(issueId: string): Promise<ManagedIssueShare | null> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${encodeURIComponent(issueId)}/share/extend`, {
      method: "POST",
    });
    return parseWithFallback(
      raw,
      ManagedIssueShareResponseSchema,
      EMPTY_MANAGED_ISSUE_SHARE_RESPONSE,
      { endpoint: "POST /api/issues/:id/share/extend" },
    ).share;
  }

  async revokeIssueShare(issueId: string): Promise<void> {
    await this.http.fetch(`/api/issues/${encodeURIComponent(issueId)}/share`, {
      method: "DELETE",
    });
  }

  async getSharedIssue(token: string): Promise<SharedIssueBundle> {
    const raw = await this.http.fetch<unknown>(`/api/shares/${encodeURIComponent(token)}`);
    return parseWithFallback(raw, SharedIssueBundleSchema, EMPTY_SHARED_ISSUE_BUNDLE, {
      endpoint: "GET /api/shares/:token",
    }) as SharedIssueBundle;
  }

  async getSharedTaskTrace(token: string, taskId: string, afterSeq = 0): Promise<SharedTaskTracePage> {
    const query = new URLSearchParams({ after_seq: String(afterSeq) });
    const raw = await this.http.fetch<unknown>(`/api/shares/${encodeURIComponent(token)}/tasks/${encodeURIComponent(taskId)}/trace?${query}`);
    return parseStrictResponse(raw, SharedTaskTracePageSchema, {
      endpoint: "GET /api/shares/:token/tasks/:task_id/trace",
    }) as SharedTaskTracePage;
  }
}
