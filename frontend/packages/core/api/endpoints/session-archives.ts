import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  EMPTY_WORKSPACE_SESSION_ARCHIVE_STATUS,
  IssueSessionArchivesResponseSchema,
  SessionArchiveRetryResponseSchema,
  SessionArchiveVerifyResponseSchema,
  WorkspaceSessionArchiveStatusSchema,
  WorkspaceSessionArchiveMutationResponseSchema,
  type IssueSessionArchivesResponse,
  type SessionArchiveRetryResponse,
  type SessionArchiveVerifyResponse,
  type WorkspaceSessionArchiveStatus,
} from "../schemas/session-archives";

export class SessionArchivesEndpoints {
  constructor(readonly http: HttpClient) {}

  async getWorkspaceSessionArchiveConfig(
    workspaceId: string,
  ): Promise<WorkspaceSessionArchiveStatus> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/session-archive`,
    );
    return parseWithFallback(
      raw,
      WorkspaceSessionArchiveStatusSchema,
      EMPTY_WORKSPACE_SESSION_ARCHIVE_STATUS,
      { endpoint: "GET /api/workspaces/:id/session-archive" },
    );
  }

  async updateWorkspaceSessionArchiveConfig(
    workspaceId: string,
    data: { workspace_ttl_ms: number; gc_interval_ms: number },
  ): Promise<WorkspaceSessionArchiveStatus> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/session-archive`,
      { method: "PUT", body: JSON.stringify(data) },
    );
    return parseStrictResponse(raw, WorkspaceSessionArchiveMutationResponseSchema, {
      endpoint: "PUT /api/workspaces/:id/session-archive",
    });
  }

  async listIssueSessionArchives(
    issueId: string,
  ): Promise<IssueSessionArchivesResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${encodeURIComponent(issueId)}/session-archives`,
    );
    return parseStrictResponse(raw, IssueSessionArchivesResponseSchema, {
      endpoint: "GET /api/issues/:id/session-archives",
    });
  }

  async verifyIssueSessionArchive(
    issueId: string,
    archiveId: string,
  ): Promise<SessionArchiveVerifyResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/verify`,
      { method: "POST", body: "{}" },
    );
    return parseStrictResponse(raw, SessionArchiveVerifyResponseSchema, {
      endpoint: "POST /api/issues/:id/session-archives/:archiveId/verify",
    });
  }

  async retryIssueSessionArchive(
    issueId: string,
    archiveId: string,
  ): Promise<SessionArchiveRetryResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/retry`,
      { method: "POST", body: "{}" },
    );
    return parseStrictResponse(raw, SessionArchiveRetryResponseSchema, {
      endpoint: "POST /api/issues/:id/session-archives/:archiveId/retry",
    });
  }
}
