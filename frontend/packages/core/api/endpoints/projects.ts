import type {
  CreateProjectRequest,
  CreateProjectResourceRequest,
  ListProjectResourcesResponse,
  ListProjectDevicesResponse,
  ListProjectsResponse,
  Project,
  ProjectResource,
  ProjectDeviceMutationResponse,
  UpdateProjectRequest,
  UpdateProjectResourceRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_PROJECT,
  EMPTY_PROJECT_LIST,
  ListProjectsResponseSchema,
  ProjectSchema,
  EMPTY_PROJECT_DEVICE_LIST,
  EMPTY_PROJECT_DEVICE_MUTATION,
  ListProjectDevicesResponseSchema,
  ProjectDeviceMutationResponseSchema,
} from "../schemas/projects";

export class ProjectsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Projects
  async listProjects(params?: { status?: string }): Promise<ListProjectsResponse> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    const raw = await this.http.fetch<unknown>(`/api/projects?${search}`);
    return parseWithFallback(raw, ListProjectsResponseSchema, EMPTY_PROJECT_LIST, {
      endpoint: "GET /api/projects",
    });
  }

  async getProject(id: string): Promise<Project> {
    const raw = await this.http.fetch<unknown>(`/api/projects/${id}`);
    return parseWithFallback(raw, ProjectSchema, EMPTY_PROJECT, {
      endpoint: "GET /api/projects/:id",
    });
  }

  async createProject(data: CreateProjectRequest): Promise<Project> {
    const raw = await this.http.fetch<unknown>("/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, ProjectSchema, EMPTY_PROJECT, {
      endpoint: "POST /api/projects",
    });
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
    const raw = await this.http.fetch<unknown>(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, ProjectSchema, EMPTY_PROJECT, {
      endpoint: "PUT /api/projects/:id",
    });
  }

  async archiveProject(id: string): Promise<void> {
    await this.http.fetch(`/api/projects/${id}`, { method: "DELETE" });
  }

  async restoreProject(id: string): Promise<Project> {
    const raw = await this.http.fetch<unknown>(`/api/projects/${id}/restore`, {
      method: "POST",
    });
    return parseWithFallback(raw, ProjectSchema, EMPTY_PROJECT, {
      endpoint: "POST /api/projects/:id/restore",
    });
  }

  // Project resources
  async listProjectResources(
    projectId: string,
  ): Promise<ListProjectResourcesResponse> {
    return this.http.fetch(`/api/projects/${projectId}/resources`);
  }

  async createProjectResource(
    projectId: string,
    data: CreateProjectResourceRequest,
  ): Promise<ProjectResource> {
    return this.http.fetch(`/api/projects/${projectId}/resources`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateProjectResource(
    projectId: string,
    resourceId: string,
    data: UpdateProjectResourceRequest,
  ): Promise<ProjectResource> {
    return this.http.fetch(`/api/projects/${projectId}/resources/${resourceId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteProjectResource(
    projectId: string,
    resourceId: string,
  ): Promise<void> {
    await this.http.fetch(`/api/projects/${projectId}/resources/${resourceId}`, {
      method: "DELETE",
    });
  }

  async listProjectDevices(projectId: string): Promise<ListProjectDevicesResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/devices`,
    );
    return parseWithFallback(
      raw,
      ListProjectDevicesResponseSchema,
      EMPTY_PROJECT_DEVICE_LIST,
      { endpoint: "GET /api/projects/:id/devices" },
    );
  }

  async createProjectDevice(
    projectId: string,
    daemonId: string,
  ): Promise<ProjectDeviceMutationResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/devices`,
      { method: "POST", body: JSON.stringify({ daemon_id: daemonId }) },
    );
    return parseWithFallback(
      raw,
      ProjectDeviceMutationResponseSchema,
      EMPTY_PROJECT_DEVICE_MUTATION,
      { endpoint: "POST /api/projects/:id/devices" },
    );
  }

  async deleteProjectDevice(projectId: string, daemonId: string): Promise<void> {
    await this.http.fetch(
      `/api/projects/${encodeURIComponent(projectId)}/devices/${encodeURIComponent(daemonId)}`,
      { method: "DELETE" },
    );
  }
}
