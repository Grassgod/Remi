import type {
  CreateScmConnectionRequest,
  ListScmConnectionsResponse,
  ListScmEventsResponse,
  ListIssueChangeRequestsResponse,
  ScmCapabilitiesResponse,
  ScmConnectionResponse,
  UpdateScmConnectionRequest,
  UpdateScmRepositoryBindingRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_LIST_SCM_CONNECTIONS_RESPONSE,
  EMPTY_LIST_SCM_EVENTS_RESPONSE,
  EMPTY_SCM_CAPABILITIES_RESPONSE,
  EMPTY_SCM_CONNECTION_RESPONSE,
  ListScmConnectionsResponseSchema,
  ListScmEventsResponseSchema,
  ListIssueChangeRequestsResponseSchema,
  ScmCapabilitiesResponseSchema,
  ScmConnectionResponseSchema,
  EMPTY_LIST_ISSUE_CHANGE_REQUESTS_RESPONSE,
} from "../schemas/scm";

export class ScmEndpoints {
  constructor(readonly http: HttpClient) {}

  async getScmCapabilities(): Promise<ScmCapabilitiesResponse | null> {
    const raw = await this.http.fetch<unknown>("/api/scm/capabilities");
    return parseWithFallback(
      raw,
      ScmCapabilitiesResponseSchema,
      EMPTY_SCM_CAPABILITIES_RESPONSE,
      { endpoint: "GET /api/scm/capabilities" },
    );
  }

  async listScmConnections(workspaceId: string): Promise<ListScmConnectionsResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections`,
    );
    return parseWithFallback(
      raw,
      ListScmConnectionsResponseSchema,
      EMPTY_LIST_SCM_CONNECTIONS_RESPONSE,
      { endpoint: "GET /api/workspaces/:id/scm/connections" },
    );
  }

  async getScmConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ScmConnectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}`,
    );
    return parseWithFallback(raw, ScmConnectionResponseSchema, EMPTY_SCM_CONNECTION_RESPONSE, {
      endpoint: "GET /api/workspaces/:id/scm/connections/:connectionId",
    });
  }

  async createScmConnection(
    workspaceId: string,
    input: CreateScmConnectionRequest,
  ): Promise<ScmConnectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback(raw, ScmConnectionResponseSchema, EMPTY_SCM_CONNECTION_RESPONSE, {
      endpoint: "POST /api/workspaces/:id/scm/connections",
    });
  }

  async updateScmConnection(
    workspaceId: string,
    connectionId: string,
    input: UpdateScmConnectionRequest,
  ): Promise<ScmConnectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return parseWithFallback(raw, ScmConnectionResponseSchema, EMPTY_SCM_CONNECTION_RESPONSE, {
      endpoint: "PATCH /api/workspaces/:id/scm/connections/:connectionId",
    });
  }

  async deleteScmConnection(workspaceId: string, connectionId: string): Promise<void> {
    await this.http.fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  async verifyScmConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ScmConnectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}/verify`,
      { method: "POST" },
    );
    return parseWithFallback(raw, ScmConnectionResponseSchema, EMPTY_SCM_CONNECTION_RESPONSE, {
      endpoint: "POST /api/workspaces/:id/scm/connections/:connectionId/verify",
    });
  }

  async listIssueChangeRequests(issueId: string): Promise<ListIssueChangeRequestsResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${encodeURIComponent(issueId)}/change-requests`,
    );
    return parseWithFallback(
      raw,
      ListIssueChangeRequestsResponseSchema,
      EMPTY_LIST_ISSUE_CHANGE_REQUESTS_RESPONSE,
      { endpoint: "GET /api/issues/:id/change-requests" },
    );
  }

  async bindScmRepository(
    workspaceId: string,
    connectionId: string,
    repositoryId: string,
    input: UpdateScmRepositoryBindingRequest = {},
  ): Promise<ScmConnectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}/repositories/${encodeURIComponent(repositoryId)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return parseWithFallback(raw, ScmConnectionResponseSchema, EMPTY_SCM_CONNECTION_RESPONSE, {
      endpoint: "PUT /api/workspaces/:id/scm/connections/:connectionId/repositories/:repositoryId",
    });
  }

  async unbindScmRepository(
    workspaceId: string,
    connectionId: string,
    repositoryId: string,
  ): Promise<void> {
    await this.http.fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/connections/${encodeURIComponent(connectionId)}/repositories/${encodeURIComponent(repositoryId)}`,
      { method: "DELETE" },
    );
  }

  async listScmEvents(
    workspaceId: string,
    params?: { repositoryId?: string; type?: string; after?: string; limit?: number },
  ): Promise<ListScmEventsResponse> {
    const search = new URLSearchParams();
    if (params?.repositoryId) search.set("repositoryId", params.repositoryId);
    if (params?.type) search.set("type", params.type);
    if (params?.after) search.set("after", params.after);
    if (params?.limit) search.set("limit", String(params.limit));
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/scm/events?${search}`,
    );
    return parseWithFallback(
      raw,
      ListScmEventsResponseSchema,
      EMPTY_LIST_SCM_EVENTS_RESPONSE,
      { endpoint: "GET /api/workspaces/:id/scm/events" },
    );
  }
}
