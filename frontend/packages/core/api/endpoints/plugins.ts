import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  AgentPluginBindingDetailSchema,
  AgentPluginBindingListSchema,
  AgentPluginDetailSchema,
  AgentPluginRepositoryInspectionResponseSchema,
  AgentPluginListSchema,
  AgentPluginRuntimeStateListSchema,
  AgentPluginVersionListSchema,
  CreateAgentPluginVersionResultSchema,
  EMPTY_AGENT_PLUGIN_BINDING,
  EMPTY_AGENT_PLUGIN_BINDING_LIST,
  EMPTY_AGENT_PLUGIN_DETAIL,
  EMPTY_AGENT_PLUGIN_REPOSITORY_INSPECTION,
  EMPTY_AGENT_PLUGIN_LIST,
  EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
  EMPTY_AGENT_PLUGIN_VERSION_LIST,
  EMPTY_CREATE_AGENT_PLUGIN_VERSION_RESULT,
} from "../../plugins/schemas";
import {
  AGENT_PLUGINS_API_BASE,
  type AgentPlugin,
  type AgentPluginBinding,
  type AgentPluginRuntimeState,
  type AgentPluginRepositoryInspection,
  type AgentPluginVersion,
  type CreateAgentPluginBindingInput,
  type CreateAgentPluginVersionInput,
  type CreateAgentPluginVersionResult,
  type ImportAgentPluginRequest,
  type InspectAgentPluginRepositoryInput,
  type UpdateAgentPluginBindingInput,
} from "../../plugins/types";

const AGENTS_API_BASE = "/api/multiremi/agents";
const RUNTIMES_API_BASE = "/api/multiremi/runtimes";

export class PluginsEndpoints {
  constructor(readonly http: HttpClient) {}

  async listAgentPlugins(
    provider?: string,
    workspaceId?: string,
  ): Promise<AgentPlugin[]> {
    const search = new URLSearchParams();
    if (provider) search.set("provider", provider);
    if (workspaceId) search.set("workspace_id", workspaceId);
    const query = search.toString();
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}${query ? `?${query}` : ""}`,
    );
    return parseWithFallback(
      raw,
      AgentPluginListSchema,
      EMPTY_AGENT_PLUGIN_LIST,
      { endpoint: "GET /api/multiremi/agent-plugins" },
    );
  }

  async inspectAgentPluginRepository(
    input: InspectAgentPluginRepositoryInput,
  ): Promise<AgentPluginRepositoryInspection | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/inspect`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback<AgentPluginRepositoryInspection | null>(
      raw,
      AgentPluginRepositoryInspectionResponseSchema,
      EMPTY_AGENT_PLUGIN_REPOSITORY_INSPECTION,
      { endpoint: "POST /api/multiremi/agent-plugins/inspect" },
    );
  }

  async importAgentPlugin(input: ImportAgentPluginRequest): Promise<AgentPlugin | null> {
    const raw = await this.http.fetch<unknown>(`${AGENT_PLUGINS_API_BASE}/import`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseWithFallback<AgentPlugin | null>(
      raw,
      AgentPluginDetailSchema,
      EMPTY_AGENT_PLUGIN_DETAIL,
      { endpoint: "POST /api/multiremi/agent-plugins/import" },
    );
  }

  async getAgentPlugin(pluginId: string): Promise<AgentPlugin | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}`,
    );
    return parseWithFallback<AgentPlugin | null>(
      raw,
      AgentPluginDetailSchema,
      EMPTY_AGENT_PLUGIN_DETAIL,
      { endpoint: "GET /api/multiremi/agent-plugins/:id" },
    );
  }

  async listAgentPluginVersions(
    pluginId: string,
  ): Promise<AgentPluginVersion[]> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/versions`,
    );
    return parseWithFallback(
      raw,
      AgentPluginVersionListSchema,
      EMPTY_AGENT_PLUGIN_VERSION_LIST,
      { endpoint: "GET /api/multiremi/agent-plugins/:id/versions" },
    );
  }

  async createAgentPluginVersion(
    pluginId: string,
    input: CreateAgentPluginVersionInput,
  ): Promise<CreateAgentPluginVersionResult | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/versions`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback<CreateAgentPluginVersionResult | null>(
      raw,
      CreateAgentPluginVersionResultSchema,
      EMPTY_CREATE_AGENT_PLUGIN_VERSION_RESULT,
      { endpoint: "POST /api/multiremi/agent-plugins/:id/versions" },
    );
  }

  async activateAgentPluginVersion(
    pluginId: string,
    versionId: string,
  ): Promise<AgentPlugin | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/activate`,
      { method: "POST", body: JSON.stringify({ versionId }) },
    );
    return parseWithFallback<AgentPlugin | null>(
      raw,
      AgentPluginDetailSchema,
      EMPTY_AGENT_PLUGIN_DETAIL,
      { endpoint: "POST /api/multiremi/agent-plugins/:id/activate" },
    );
  }

  async rollbackAgentPluginVersion(
    pluginId: string,
    versionId?: string,
  ): Promise<AgentPlugin | null> {
    const input = versionId === undefined ? {} : { versionId };
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/rollback`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback<AgentPlugin | null>(
      raw,
      AgentPluginDetailSchema,
      EMPTY_AGENT_PLUGIN_DETAIL,
      { endpoint: "POST /api/multiremi/agent-plugins/:id/rollback" },
    );
  }

  async listAgentPluginRuntimeStates(
    pluginId: string,
  ): Promise<AgentPluginRuntimeState[]> {
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/runtimes`,
    );
    return parseWithFallback(
      raw,
      AgentPluginRuntimeStateListSchema,
      EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
      { endpoint: "GET /api/multiremi/agent-plugins/:id/runtimes" },
    );
  }

  async listRuntimeAgentPluginStates(
    runtimeId: string,
  ): Promise<AgentPluginRuntimeState[]> {
    const raw = await this.http.fetch<unknown>(
      `${RUNTIMES_API_BASE}/${encodeURIComponent(runtimeId)}/agent-plugins`,
    );
    return parseWithFallback(
      raw,
      AgentPluginRuntimeStateListSchema,
      EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
      { endpoint: "GET /api/multiremi/runtimes/:runtimeId/agent-plugins" },
    );
  }

  async listAgentPluginBindings(agentId: string): Promise<AgentPluginBinding[]> {
    const raw = await this.http.fetch<unknown>(
      `${AGENTS_API_BASE}/${encodeURIComponent(agentId)}/plugins`,
    );
    return parseWithFallback(
      raw,
      AgentPluginBindingListSchema,
      EMPTY_AGENT_PLUGIN_BINDING_LIST,
      { endpoint: "GET /api/multiremi/agents/:id/plugins" },
    );
  }

  async createAgentPluginBinding(
    agentId: string,
    input: CreateAgentPluginBindingInput,
  ): Promise<AgentPluginBinding | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENTS_API_BASE}/${encodeURIComponent(agentId)}/plugins`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback<AgentPluginBinding | null>(
      raw,
      AgentPluginBindingDetailSchema,
      EMPTY_AGENT_PLUGIN_BINDING,
      { endpoint: "POST /api/multiremi/agents/:id/plugins" },
    );
  }

  async updateAgentPluginBinding(
    agentId: string,
    bindingId: string,
    input: UpdateAgentPluginBindingInput,
  ): Promise<AgentPluginBinding | null> {
    const raw = await this.http.fetch<unknown>(
      `${AGENTS_API_BASE}/${encodeURIComponent(agentId)}/plugins/${encodeURIComponent(bindingId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return parseWithFallback<AgentPluginBinding | null>(
      raw,
      AgentPluginBindingDetailSchema,
      EMPTY_AGENT_PLUGIN_BINDING,
      { endpoint: "PATCH /api/multiremi/agents/:id/plugins/:bindingId" },
    );
  }

  async deleteAgentPluginBinding(
    agentId: string,
    bindingId: string,
  ): Promise<void> {
    await this.http.fetch(
      `${AGENTS_API_BASE}/${encodeURIComponent(agentId)}/plugins/${encodeURIComponent(bindingId)}`,
      { method: "DELETE" },
    );
  }

  async retryAgentPluginRuntime(
    pluginId: string,
    runtimeId: string,
    versionId?: string,
  ): Promise<AgentPluginRuntimeState[]> {
    const input = versionId === undefined
      ? { runtimeId }
      : { runtimeId, versionId };
    const raw = await this.http.fetch<unknown>(
      `${AGENT_PLUGINS_API_BASE}/${encodeURIComponent(pluginId)}/runtimes/retry`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseWithFallback(
      raw,
      AgentPluginRuntimeStateListSchema,
      EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
      {
        endpoint:
          "POST /api/multiremi/agent-plugins/:id/runtimes/retry",
      },
    );
  }
}
