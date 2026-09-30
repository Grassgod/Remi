import type {
  AnswerIssueDecisionInput,
  CreateIssueRequest,
  GroupedIssuesResponse,
  Issue,
  IssueDependency,
  IssueRetitleResponse,
  IssueWorkspace,
  ListGroupedIssuesParams,
  ListIssuesParams,
  ListIssuesResponse,
  ListIssueStatusPagesParams,
  IssueStatusPagesResponse,
  MultiremiIssueDecision,
  MultiremiIssueDecisionList,
  MultiremiIssueParentDoneGrant,
  SearchIssuesResponse,
  SearchProjectsResponse,
  UpdateIssueRequest,
} from "../../types";
import { ApiError, type HttpClient } from "../http";
import { ApiContractError, parseStrictResponse, parseWithFallback } from "../schema";
import {
  BatchUpdateIssuesResponseSchema,
  ChildIssuesResponseSchema,
  IssueDependenciesResponseSchema,
  IssueDependencyMutationSchema,
  EMPTY_ISSUE_RETITLE_RESPONSE,
  EMPTY_ISSUE_WORKSPACE_RESPONSE,
  EMPTY_GROUPED_ISSUES_RESPONSE,
  EMPTY_LIST_ISSUES_RESPONSE,
  GroupedIssuesResponseSchema,
  IssueDecisionListSchema,
  IssueDecisionMutationResponseSchema,
  IssueDetailSchema,
  IssueSchema,
  IssueParentDoneGrantMutationResponseSchema,
  QuickCreateIssueResponseSchema,
  IssueRetitleResponseSchema,
  IssueWorkspaceResponseSchema,
  ListIssuesResponseSchema,
  IssueStatusPagesResponseSchema,
} from "../schemas/issues";

// One capability probe per API client, including concurrent "All my issues" fetches.
const statusPagesSupport = new WeakMap<HttpClient, {
  known: boolean;
  missing: boolean;
  probe?: Promise<void>;
}>();

function issueListSearch(params?: ListIssuesParams): URLSearchParams {
  const search = new URLSearchParams();
  if (params?.top_level_only) search.set("top_level_only", "true");
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.offset) search.set("offset", String(params.offset));
  if (params?.workspace_id) search.set("workspace_id", params.workspace_id);
  if (params?.status) search.set("status", params.status);
  if (params?.statuses?.length) search.set("statuses", params.statuses.join(","));
  if (params?.priority) search.set("priority", params.priority);
  if (params?.assignee_id) search.set("assignee_id", params.assignee_id);
  if (params?.assignee_ids?.length) search.set("assignee_ids", params.assignee_ids.join(","));
  if (params?.creator_id) search.set("creator_id", params.creator_id);
  if (params?.project_id) search.set("project_id", params.project_id);
  if (params?.involves_user_id) search.set("involves_user_id", params.involves_user_id);
  if (params?.metadata && Object.keys(params.metadata).length > 0) search.set("metadata", JSON.stringify(params.metadata));
  if (params?.open_only) search.set("open_only", "true");
  if (params?.scheduled) search.set("scheduled", "true");
  if (params?.include_archived) search.set("include_archived", "true");
  if (params?.archived_only) search.set("archived_only", "true");
  if (params?.sort_by) search.set("sort", params.sort_by);
  if (params?.sort_direction) search.set("direction", params.sort_direction);
  return search;
}

async function legacyStatusPages(endpoint: IssuesEndpoints, params: ListIssueStatusPagesParams): Promise<IssueStatusPagesResponse> {
  const [pages, archived] = await Promise.all([
    Promise.all(params.statuses.map((status) => endpoint.listIssues({ ...params, statuses: undefined, status, offset: 0 }))),
    params.include_archived_total
      ? endpoint.listIssues({ workspace_id: params.workspace_id, archived_only: true, limit: 1, offset: 0 })
      : undefined,
  ]);
  return {
    groups: Object.fromEntries(pages.map((page, index) => [params.statuses[index]!, {
      ...page, has_more: page.issues.length < page.total,
    }])),
    ...(archived ? { archived_total: archived.total } : {}),
  };
}

export class IssuesEndpoints {
  constructor(readonly http: HttpClient) {}

  // Issues
  async listIssues(params?: ListIssuesParams): Promise<ListIssuesResponse> {
    const search = issueListSearch(params);
    const path = `/api/issues?${search}`;
    const raw = await this.http.fetch<unknown>(path);
    return parseWithFallback(raw, ListIssuesResponseSchema, EMPTY_LIST_ISSUES_RESPONSE, {
      endpoint: "GET /api/issues",
    });
  }

  async listIssueStatusPages(params: ListIssueStatusPagesParams): Promise<IssueStatusPagesResponse> {
    let support = statusPagesSupport.get(this.http);
    if (!support) {
      support = { known: false, missing: false };
      statusPagesSupport.set(this.http, support);
    }
    if (support.probe) await support.probe;
    if (support.missing) return legacyStatusPages(this, params);
    let release: (() => void) | undefined;
    if (!support.known) support.probe = new Promise<void>((resolve) => { release = resolve; });
    try {
      const search = issueListSearch(params);
      if (params.limit === 0) search.set("limit", "0");
      if (params.include_archived_total) search.set("include_archived_total", "true");
      const raw = await this.http.fetch<unknown>(`/api/issues/status-pages?${search}`);
      support.known = true;
      const result = parseStrictResponse<IssueStatusPagesResponse>(raw, IssueStatusPagesResponseSchema, {
        endpoint: "GET /api/issues/status-pages",
      });
      if (params.statuses.some((status) => !result.groups[status])
        || (params.include_archived_total && result.archived_total === undefined)) {
        throw new ApiContractError("GET /api/issues/status-pages", "Missing requested status pages or archived_total");
      }
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      support.missing = true;
      return legacyStatusPages(this, params);
    } finally {
      if (release) { support.probe = undefined; release(); }
    }
  }

  async listGroupedIssues(params: ListGroupedIssuesParams): Promise<GroupedIssuesResponse> {
    const search = new URLSearchParams({ group_by: params.group_by });
    if (params.top_level_only) search.set("top_level_only", "true");
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    if (params.workspace_id) search.set("workspace_id", params.workspace_id);
    if (params.statuses?.length) search.set("statuses", params.statuses.join(","));
    if (params.priorities?.length) search.set("priorities", params.priorities.join(","));
    if (params.assignee_types?.length) search.set("assignee_types", params.assignee_types.join(","));
    if (params.assignee_id) search.set("assignee_id", params.assignee_id);
    if (params.assignee_ids?.length) search.set("assignee_ids", params.assignee_ids.join(","));
    if (params.creator_id) search.set("creator_id", params.creator_id);
    if (params.project_id) search.set("project_id", params.project_id);
    if (params.involves_user_id) search.set("involves_user_id", params.involves_user_id);
    if (params.metadata && Object.keys(params.metadata).length > 0) {
      search.set("metadata", JSON.stringify(params.metadata));
    }
    if (params.assignee_filters?.length) {
      search.set("assignee_filters", params.assignee_filters.map((f) => `${f.type}:${f.id}`).join(","));
    }
    if (params.include_no_assignee) search.set("include_no_assignee", "true");
    if (params.creator_filters?.length) {
      search.set("creator_filters", params.creator_filters.map((f) => `${f.type}:${f.id}`).join(","));
    }
    if (params.project_ids?.length) search.set("project_ids", params.project_ids.join(","));
    if (params.include_no_project) search.set("include_no_project", "true");
    if (params.label_ids?.length) search.set("label_ids", params.label_ids.join(","));
    if (params.group_assignee_type) search.set("group_assignee_type", params.group_assignee_type);
    if (params.group_assignee_id) search.set("group_assignee_id", params.group_assignee_id);
    if (params.include_archived) search.set("include_archived", "true");
    if (params.archived_only) search.set("archived_only", "true");
    if (params.include_archived_total) search.set("include_archived_total", "true");
    if (params.sort_by) search.set("sort", params.sort_by);
    if (params.sort_direction) search.set("direction", params.sort_direction);
    const raw = await this.http.fetch<unknown>(`/api/issues/grouped?${search}`);
    const result = parseWithFallback(raw, GroupedIssuesResponseSchema, EMPTY_GROUPED_ISSUES_RESPONSE, {
      endpoint: "GET /api/issues/grouped",
    });
    // Older API versions ignore the additive archive parameter on this route.
    if (params.include_archived_total && result.archived_total === undefined) {
      const archived = await this.listIssues({ workspace_id: params.workspace_id, archived_only: true, limit: 1 });
      return { ...result, archived_total: archived.total };
    }
    return result;
  }

  async searchIssues(params: { q: string; limit?: number; offset?: number; include_closed?: boolean; signal?: AbortSignal }): Promise<SearchIssuesResponse> {
    const search = new URLSearchParams({ q: params.q });
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    if (params.include_closed) search.set("include_closed", "true");
    return this.http.fetch(`/api/issues/search?${search}`, params.signal ? { signal: params.signal } : undefined);
  }

  async searchProjects(params: { q: string; limit?: number; offset?: number; include_closed?: boolean; signal?: AbortSignal }): Promise<SearchProjectsResponse> {
    const search = new URLSearchParams({ q: params.q });
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    if (params.include_closed) search.set("include_closed", "true");
    return this.http.fetch(`/api/projects/search?${search}`, params.signal ? { signal: params.signal } : undefined);
  }

  async getIssue(id: string): Promise<Issue> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}`);
    return parseStrictResponse<Issue>(raw, IssueDetailSchema, {
      endpoint: "GET /api/issues/:id",
    });
  }

  async listIssueDecisions(id: string): Promise<MultiremiIssueDecisionList> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/decisions`);
    return parseStrictResponse<MultiremiIssueDecisionList>(raw, IssueDecisionListSchema, {
      endpoint: "GET /api/issues/:id/decisions",
    });
  }

  async answerIssueDecision(
    id: string,
    decisionId: string,
    input: AnswerIssueDecisionInput,
  ): Promise<MultiremiIssueDecision> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/${id}/decisions/${decisionId}/answer`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseStrictResponse<{ decision: MultiremiIssueDecision }>(
      raw,
      IssueDecisionMutationResponseSchema,
      { endpoint: "POST /api/issues/:id/decisions/:decisionId/answer" },
    ).decision;
  }

  async grantParentDone(id: string): Promise<MultiremiIssueParentDoneGrant> {
    const raw = await this.http.fetch<unknown>(
      `/api/multiremi/issues/${id}/parent-done-grant`,
      { method: "POST" },
    );
    const parsed = parseStrictResponse<{
      issue: unknown;
      parent_done_grant: MultiremiIssueParentDoneGrant | null;
    }>(
      raw,
      IssueParentDoneGrantMutationResponseSchema,
      { endpoint: "POST /api/multiremi/issues/:id/parent-done-grant" },
    );
    if (!parsed.parent_done_grant) {
      throw new ApiContractError(
        "POST /api/multiremi/issues/:id/parent-done-grant",
        "Server did not return the created parent done grant",
      );
    }
    return parsed.parent_done_grant;
  }

  async revokeParentDone(id: string): Promise<null> {
    const raw = await this.http.fetch<unknown>(
      `/api/multiremi/issues/${id}/parent-done-grant`,
      { method: "DELETE" },
    );
    const parsed = parseStrictResponse<{
      issue: unknown;
      parent_done_grant: MultiremiIssueParentDoneGrant | null;
    }>(
      raw,
      IssueParentDoneGrantMutationResponseSchema,
      { endpoint: "DELETE /api/multiremi/issues/:id/parent-done-grant" },
    );
    if (parsed.parent_done_grant !== null) {
      throw new ApiContractError(
        "DELETE /api/multiremi/issues/:id/parent-done-grant",
        "Server retained the revoked parent done grant",
      );
    }
    return null;
  }

  async getIssueWorkspace(id: string): Promise<{ workspace: IssueWorkspace | null }> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/workspace`);
    return parseWithFallback(
      raw,
      IssueWorkspaceResponseSchema,
      EMPTY_ISSUE_WORKSPACE_RESPONSE,
      { endpoint: "GET /api/issues/:id/workspace" },
    );
  }

  async createIssue(data: CreateIssueRequest): Promise<Issue> {
    const raw = await this.http.fetch<unknown>("/api/issues", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseIssueMutation(raw, "POST /api/issues", data);
  }

  async quickCreateIssue(data: {
    runtime_workspace_id?: string | null;
    agent_id?: string;
    squad_id?: string;
    prompt: string;
    project_id?: string | null;
    parent_issue_id?: string | null;
  }): Promise<{ task_id: string; issue: Issue }> {
    const raw = await this.http.fetch<unknown>("/api/issues/quick-create", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const result = parseStrictResponse<{ task_id: string; issue: Issue }>(raw, QuickCreateIssueResponseSchema, { endpoint: "POST /api/issues/quick-create" });
    return { task_id: result.task_id, issue: parseIssueMutation(result.issue, "POST /api/issues/quick-create", data) };
  }

  async listGeneratedIssues(id: string): Promise<{ issues: Issue[]; total: number }> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/generated-issues`);
    return parseWithFallback(raw, ListIssuesResponseSchema, EMPTY_LIST_ISSUES_RESPONSE, {
      endpoint: "GET /api/issues/:id/generated-issues",
    });
  }

  async updateIssue(id: string, data: UpdateIssueRequest): Promise<Issue> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseIssueMutation(raw, "PUT /api/issues/:id", data);
  }

  async patchIssue(id: string, data: UpdateIssueRequest): Promise<Issue> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return parseIssueMutation(raw, "PATCH /api/issues/:id", data);
  }

  async retitleIssue(id: string, apply = true): Promise<IssueRetitleResponse> {
    const raw = await this.http.fetch<unknown>(`/api/multiremi/issues/${id}/retitle`, {
      method: "POST",
      body: JSON.stringify({ apply }),
    });
    return parseWithFallback(
      raw,
      IssueRetitleResponseSchema,
      EMPTY_ISSUE_RETITLE_RESPONSE,
      { endpoint: "POST /api/multiremi/issues/:id/retitle" },
    );
  }

  async restoreIssue(id: string): Promise<Issue> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/restore`, {
      method: "POST",
    });
    return parseStrictResponse<Issue>(raw, IssueSchema, {
      endpoint: "POST /api/issues/:id/restore",
    });
  }

  async listChildIssues(id: string): Promise<{ issues: Issue[] }> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/children`);
    return parseWithFallback(raw, ChildIssuesResponseSchema, { issues: [] }, {
      endpoint: "GET /api/issues/:id/children",
    });
  }

  async listIssueDependencies(id: string): Promise<IssueDependency[]> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/dependencies`);
    return parseWithFallback(raw, IssueDependenciesResponseSchema, { dependencies: [] }, {
      endpoint: "GET /api/issues/:id/dependencies",
    }).dependencies;
  }

  async addIssueDependency(id: string, dependsOnIssueId: string): Promise<IssueDependency> {
    const raw = await this.http.fetch<unknown>(`/api/issues/${id}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ depends_on_issue_id: dependsOnIssueId, type: "blocked_by" }),
    });
    return parseStrictResponse<{ dependency: IssueDependency }>(raw, IssueDependencyMutationSchema, {
      endpoint: "POST /api/issues/:id/dependencies",
    }).dependency;
  }

  async removeIssueDependency(id: string, dependencyId: string): Promise<void> {
    await this.http.fetch(`/api/issues/${id}/dependencies/${dependencyId}`, { method: "DELETE" });
  }

  /** Batched variant — returns children for multiple parents in one request.
   *  Avoids an N-request fan-out in Swimlane (one per visible parent lane).
   *  parentIds must be non-empty; pass a sorted, deduplicated list so the
   *  React Query cache key is stable across renders. */
  async listChildrenByParents(parentIds: string[]): Promise<{ issues: Issue[] }> {
    const raw = await this.http.fetch<unknown>(
      `/api/issues/children?parent_ids=${parentIds.join(",")}`,
    );
    return parseWithFallback(raw, ChildIssuesResponseSchema, { issues: [] }, {
      endpoint: "GET /api/issues/children",
    });
  }

  async getChildIssueProgress(): Promise<{ progress: { parentIssueId: string; total: number; done: number; cancelled: number; blocked: number; waiting: number; active: number }[] }> {
    return this.http.fetch("/api/issues/child-progress");
  }

  async deleteIssue(id: string): Promise<void> {
    await this.http.fetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  async batchUpdateIssues(issueIds: string[], updates: UpdateIssueRequest): Promise<{ updated: number; skipped: Array<{ issueId: string; error: string; code: string | null }> }> {
    const raw = await this.http.fetch<unknown>("/api/issues/batch-update", {
      method: "POST",
      body: JSON.stringify({ issue_ids: issueIds, updates }),
    });
    return parseStrictResponse(raw, BatchUpdateIssuesResponseSchema, { endpoint: "POST /api/issues/batch-update" });
  }

  async batchDeleteIssues(issueIds: string[]): Promise<{ deleted: number }> {
    return this.http.fetch("/api/issues/batch-delete", {
      method: "POST",
      body: JSON.stringify({ issue_ids: issueIds }),
    });
  }
}

function parseIssueMutation(raw: unknown, endpoint: string, input: { runtime_workspace_id?: string | null }): Issue {
  const issue = parseStrictResponse<Issue>(raw, IssueSchema, { endpoint });
  if (input.runtime_workspace_id !== undefined && (issue.runtime_workspace_id ?? null) !== input.runtime_workspace_id) {
    throw new ApiContractError(endpoint, "Server did not retain the selected runtime workspace");
  }
  return issue;
}
