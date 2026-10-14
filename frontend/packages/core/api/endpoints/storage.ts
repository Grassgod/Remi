import type {
  CreateGcRunInput,
  GcRunRequest,
  StorageSettingsPatch,
  WorkspaceStorageDaemon,
  WorkspaceStorageDaemonsResponse,
  WorkspaceStorageResponse,
} from "@multiremi/contracts/storage";
import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  GcRunResponseSchema,
  StorageReportSchema,
  WorkspaceStorageDaemonsResponseSchema,
  WorkspaceStorageResponseSchema,
} from "../schemas/storage";

export class StorageEndpoints {
  constructor(readonly http: HttpClient) {}

  async getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/storage`,
    );
    return parseStrictResponse(raw, WorkspaceStorageResponseSchema, {
      endpoint: "GET /api/workspaces/:id/storage",
    });
  }

  async updateWorkspaceStorage(
    workspaceId: string,
    patch: StorageSettingsPatch,
  ): Promise<WorkspaceStorageResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/storage`,
      { method: "PUT", body: JSON.stringify(patch) },
    );
    return parseStrictResponse(raw, WorkspaceStorageResponseSchema, {
      endpoint: "PUT /api/workspaces/:id/storage",
    });
  }

  async listWorkspaceStorageDaemons(workspaceId: string): Promise<WorkspaceStorageDaemonsResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/storage/daemons`,
    );
    const endpoint = "GET /api/workspaces/:id/storage/daemons";
    const { daemons } = parseStrictResponse<{ daemons: Array<Omit<WorkspaceStorageDaemon, "report"> & { report: unknown }> }>(
      raw,
      WorkspaceStorageDaemonsResponseSchema,
      { endpoint },
    );
    return {
      daemons: daemons.map((daemon) => ({
        ...daemon,
        report:
          daemon.report === null
            ? null
            : parseWithFallback<WorkspaceStorageDaemon["report"]>(daemon.report, StorageReportSchema, null, { endpoint }),
      })),
    };
  }

  async createRuntimeGcRun(runtimeId: string, input: CreateGcRunInput): Promise<GcRunRequest> {
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/gc-runs`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseStrictResponse<{ request: GcRunRequest }>(raw, GcRunResponseSchema, {
      endpoint: "POST /api/runtimes/:id/gc-runs",
    }).request;
  }

  async getRuntimeGcRun(runtimeId: string, requestId: string): Promise<GcRunRequest> {
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/gc-runs/${encodeURIComponent(requestId)}`,
    );
    return parseStrictResponse<{ request: GcRunRequest }>(raw, GcRunResponseSchema, {
      endpoint: "GET /api/runtimes/:id/gc-runs/:requestId",
    }).request;
  }
}
