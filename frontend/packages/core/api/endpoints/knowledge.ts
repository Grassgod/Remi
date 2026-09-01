import type {
  GetKnowledgeSubmissionResponse,
  KnowledgeRunDetail,
  ListKnowledgeRunsResponse,
  ListKnowledgeSubmissionsResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_GET_KNOWLEDGE_SUBMISSION,
  EMPTY_KNOWLEDGE_RUN_DETAIL,
  EMPTY_LIST_KNOWLEDGE_RUNS,
  EMPTY_LIST_KNOWLEDGE_SUBMISSIONS,
  GetKnowledgeSubmissionResponseSchema,
  KnowledgeRunDetailSchema,
  ListKnowledgeRunsResponseSchema,
  ListKnowledgeSubmissionsResponseSchema,
} from "../schemas/knowledge";

export class KnowledgeEndpoints {
  constructor(readonly http: HttpClient) {}

  async listKnowledgeSubmissions(workspaceId: string): Promise<ListKnowledgeSubmissionsResponse> {
    const search = new URLSearchParams({ workspace_id: workspaceId, limit: "50" });
    const raw = await this.http.fetch<unknown>(`/api/knowledge/submissions?${search}`);
    return parseWithFallback(
      raw,
      ListKnowledgeSubmissionsResponseSchema,
      EMPTY_LIST_KNOWLEDGE_SUBMISSIONS,
      { endpoint: "GET /api/knowledge/submissions" },
    );
  }

  async getKnowledgeSubmission(id: string): Promise<GetKnowledgeSubmissionResponse> {
    const raw = await this.http.fetch<unknown>(`/api/knowledge/submissions/${encodeURIComponent(id)}`);
    return parseWithFallback(
      raw,
      GetKnowledgeSubmissionResponseSchema,
      EMPTY_GET_KNOWLEDGE_SUBMISSION,
      { endpoint: "GET /api/knowledge/submissions/:id" },
    );
  }

  async listKnowledgeRuns(workspaceId: string): Promise<ListKnowledgeRunsResponse> {
    const search = new URLSearchParams({ workspace_id: workspaceId, limit: "30" });
    const raw = await this.http.fetch<unknown>(`/api/knowledge/runs?${search}`);
    return parseWithFallback(
      raw,
      ListKnowledgeRunsResponseSchema,
      EMPTY_LIST_KNOWLEDGE_RUNS,
      { endpoint: "GET /api/knowledge/runs" },
    );
  }

  async getKnowledgeRun(id: string): Promise<KnowledgeRunDetail> {
    const raw = await this.http.fetch<unknown>(`/api/knowledge/runs/${encodeURIComponent(id)}`);
    return parseWithFallback(
      raw,
      KnowledgeRunDetailSchema,
      { ...EMPTY_KNOWLEDGE_RUN_DETAIL, run: { ...EMPTY_KNOWLEDGE_RUN_DETAIL.run, id } },
      { endpoint: "GET /api/knowledge/runs/:id" },
    );
  }
}
