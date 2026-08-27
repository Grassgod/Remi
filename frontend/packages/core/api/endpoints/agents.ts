import type {
  Agent,
  AgentEnvResponse,
  AgentSupervisorState,
  AgentTemplate,
  AgentTemplateSummary,
  CreateAgentFromTemplateRequest,
  CreateAgentFromTemplateResponse,
  CreateAgentRequest,
  UpdateAgentEnvRequest,
  UpdateAgentRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  AgentSupervisorStateSchema,
  AgentTemplateSchema,
  AgentTemplateSummaryListSchema,
  CreateAgentFromTemplateResponseSchema,
  EMPTY_AGENT_TEMPLATE_DETAIL,
  EMPTY_AGENT_TEMPLATE_SUMMARY_LIST,
  EMPTY_CREATE_AGENT_FROM_TEMPLATE_RESPONSE,
  emptyAgentSupervisorState,
} from "../schemas/agents";

export class AgentsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Agents
  async listAgents(params?: { workspace_id?: string; include_archived?: boolean }): Promise<Agent[]> {
    const search = new URLSearchParams();
    if (params?.workspace_id) search.set("workspace_id", params.workspace_id);
    if (params?.include_archived) search.set("include_archived", "true");
    return this.http.fetch(`/api/agents?${search}`);
  }

  async getAgent(id: string): Promise<Agent> {
    return this.http.fetch(`/api/agents/${id}`);
  }

  async createAgent(data: CreateAgentRequest): Promise<Agent> {
    return this.http.fetch("/api/agents", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async listAgentTemplates(): Promise<AgentTemplateSummary[]> {
    const raw = await this.http.fetch<unknown>("/api/agent-templates");
    return parseWithFallback(
      raw,
      AgentTemplateSummaryListSchema,
      EMPTY_AGENT_TEMPLATE_SUMMARY_LIST,
      { endpoint: "GET /api/agent-templates" },
    );
  }

  async getAgentTemplate(slug: string): Promise<AgentTemplate> {
    const raw = await this.http.fetch<unknown>(
      `/api/agent-templates/${encodeURIComponent(slug)}`,
    );
    // Round-trip the requested slug into the fallback so a malformed
    // detail response still produces a navigable record matching the URL
    // the user clicked.
    return parseWithFallback(
      raw,
      AgentTemplateSchema,
      { ...EMPTY_AGENT_TEMPLATE_DETAIL, slug },
      { endpoint: "GET /api/agent-templates/:slug" },
    );
  }

  /** Creates an agent from a curated template. The server fetches every
   *  referenced skill URL in parallel, materializes them into the workspace
   *  (find-or-create by name), and writes the agent + skill bindings in a
   *  single transaction. On any upstream fetch failure, the entire write is
   *  rolled back and the API returns 422 with `failed_urls`. */
  async createAgentFromTemplate(
    data: CreateAgentFromTemplateRequest,
  ): Promise<CreateAgentFromTemplateResponse> {
    const raw = await this.http.fetch<unknown>("/api/agents/from-template", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(
      raw,
      CreateAgentFromTemplateResponseSchema,
      EMPTY_CREATE_AGENT_FROM_TEMPLATE_RESPONSE,
      { endpoint: "POST /api/agents/from-template" },
    );
  }

  async updateAgent(id: string, data: UpdateAgentRequest): Promise<Agent> {
    return this.http.fetch(`/api/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async setAgentSupervisor(id: string, enabled: boolean): Promise<AgentSupervisorState> {
    const raw = await this.http.fetch<unknown>(
      `/api/agents/${encodeURIComponent(id)}/supervisor`,
      {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      },
    );
    return parseWithFallback(
      raw,
      AgentSupervisorStateSchema,
      emptyAgentSupervisorState(id, enabled),
      { endpoint: "PUT /api/agents/:id/supervisor" },
    );
  }

  async archiveAgent(id: string): Promise<Agent> {
    return this.http.fetch(`/api/agents/${id}/archive`, { method: "POST" });
  }

  /**
   * Returns the plaintext `custom_env` map for an agent. Owner/admin
   * only; calls from agent-actor sessions get a 403. Every successful
   * call writes an `agent_env_revealed` activity_log row server-side.
   * MUL-2600.
   */
  async getAgentEnv(id: string): Promise<AgentEnvResponse> {
    return this.http.fetch(`/api/agents/${id}/env`);
  }

  /**
   * Replaces an agent's `custom_env` wholesale. Values equal to
   * `"****"` are preserved server-side (the **** guard) so a partial
   * UI edit doesn't overwrite real secrets with the masked
   * placeholder. Owner/admin only; agent actors get a 403. Every
   * successful call writes an `agent_env_updated` activity_log row.
   * MUL-2600.
   */
  async updateAgentEnv(id: string, data: UpdateAgentEnvRequest): Promise<AgentEnvResponse> {
    return this.http.fetch(`/api/agents/${id}/env`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async restoreAgent(id: string): Promise<Agent> {
    return this.http.fetch(`/api/agents/${id}/restore`, { method: "POST" });
  }

  // Bulk-cancel every active task (queued/dispatched/running) for the agent.
  // Permission: agent owner or workspace admin/owner. Server returns the
  // count of cancelled rows; broadcasts task:cancelled for each so other
  // surfaces can clear their live cards.
  async cancelAgentTasks(id: string): Promise<{ cancelled: number }> {
    return this.http.fetch(`/api/agents/${id}/cancel-tasks`, { method: "POST" });
  }
}
