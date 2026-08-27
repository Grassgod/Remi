import type {
  OrganizerMode,
  Workspace,
  WorkspaceOrganizerSettings,
  WorkspacePromptSettings,
  PlatformPromptTemplatePreview,
  UpdateWorkspacePromptSettingsRequest,
  WorkspaceRepo,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_WORKSPACE_ORGANIZER_SETTINGS,
  EMPTY_PLATFORM_PROMPT_TEMPLATE,
  EMPTY_WORKSPACE_ENV,
  PlatformPromptTemplatePreviewSchema,
  WorkspaceOrganizerSettingsSchema,
  WorkspaceEnvResponseSchema,
  type WorkspaceEnvResponse,
} from "../schemas/workspaces";

export class WorkspacesEndpoints {
  constructor(readonly http: HttpClient) {}

  // Workspaces
  async listWorkspaces(): Promise<Workspace[]> {
    return this.http.fetch("/api/workspaces");
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return this.http.fetch(`/api/workspaces/${id}`);
  }

  async createWorkspace(data: { name: string; slug: string; description?: string; context?: string }): Promise<Workspace> {
    return this.http.fetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateWorkspace(id: string, data: { name?: string; description?: string; context?: string; settings?: Record<string, unknown>; repos?: WorkspaceRepo[]; issue_prefix?: string; avatar_url?: string }): Promise<Workspace> {
    return this.http.fetch(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async getWorkspaceOrganizerSettings(workspaceId: string): Promise<WorkspaceOrganizerSettings> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/organizer`,
    );
    return parseWithFallback(
      raw,
      WorkspaceOrganizerSettingsSchema,
      { ...EMPTY_WORKSPACE_ORGANIZER_SETTINGS, workspace_id: workspaceId },
      { endpoint: "GET /api/workspaces/:id/organizer" },
    );
  }

  async updateWorkspaceOrganizerSettings(
    workspaceId: string,
    mode: OrganizerMode,
  ): Promise<WorkspaceOrganizerSettings> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/organizer`,
      {
        method: "PUT",
        body: JSON.stringify({ mode }),
      },
    );
    return parseWithFallback(
      raw,
      WorkspaceOrganizerSettingsSchema,
      { workspace_id: workspaceId, mode },
      { endpoint: "PUT /api/workspaces/:id/organizer" },
    );
  }

  async getWorkspacePromptSettings(workspaceId: string): Promise<WorkspacePromptSettings> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/prompts`);
  }

  async updateWorkspacePromptSettings(
    workspaceId: string,
    data: UpdateWorkspacePromptSettingsRequest,
  ): Promise<WorkspacePromptSettings> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/prompts`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async getWorkspacePromptTemplate(workspaceId: string): Promise<PlatformPromptTemplatePreview> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/prompt-template`,
    );
    return parseWithFallback(
      raw,
      PlatformPromptTemplatePreviewSchema,
      EMPTY_PLATFORM_PROMPT_TEMPLATE,
      { endpoint: "GET /api/workspaces/:id/prompt-template" },
    );
  }

  // Workspace-level env for task sessions (owner/admin only). GET returns
  // plaintext values — call it on explicit user intent (reveal), not on mount.
  async getWorkspaceEnv(workspaceId: string): Promise<WorkspaceEnvResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/env`);
    return parseWithFallback(raw, WorkspaceEnvResponseSchema, EMPTY_WORKSPACE_ENV, {
      endpoint: "GET /api/workspaces/:id/env",
    });
  }

  // Replaces the whole map; a value of "****" keeps the currently stored
  // value for that key (same contract as the agent env endpoint).
  async updateWorkspaceEnv(workspaceId: string, data: { env: Record<string, string> }): Promise<WorkspaceEnvResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/env`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, WorkspaceEnvResponseSchema, EMPTY_WORKSPACE_ENV, {
      endpoint: "PUT /api/workspaces/:id/env",
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
    });
  }
}
