import type {
  AgentRuntime,
  CreateRuntimeDirectoryScanRequest,
  CreateRuntimeLocalSkillImportRequest,
  FleetModelsResponse,
  RuntimeDirectoryScanRequest,
  RuntimeHourlyActivity,
  RuntimeLocalSkillImportRequest,
  RuntimeLocalSkillListRequest,
  RuntimeModelListRequest,
  RuntimeUpdate,
  RuntimeUsage,
  RuntimeUsageByAgent,
  RuntimeUsageByHour,
} from "../../types";
import type {
  DaemonInventoryResponse,
  DaemonRetirementPlan,
  RetireDaemonResponse,
  RuntimeProvision,
  RuntimeProvisionInput,
  RuntimeProvisionState,
  SshMeshOverview,
  SshMeshTestResponse,
} from "../../runtimes/types";
import type {
  CloudRuntimeNode,
  CreateCloudRuntimeNodeRequest,
  ListCloudRuntimeNodesParams,
} from "../../runtimes/cloud-runtime";
import type { HttpClient } from "../http";
import {
  ApiContractError,
  parseStrictResponse,
  parseWithFallback,
} from "../schema";
import {
  type CliLatestVersionResponse,
  CliLatestVersionResponseSchema,
  CloudRuntimeNodeListSchema,
  CloudRuntimeNodeSchema,
  DaemonInventoryResponseSchema,
  DaemonRetirementPlanResponseSchema,
  EMPTY_DAEMON_INVENTORY_RESPONSE,
  EMPTY_DAEMON_RETIREMENT_PLAN_RESPONSE,
  EMPTY_CLI_LATEST_VERSION,
  EMPTY_CLOUD_RUNTIME_NODE,
  EMPTY_CLOUD_RUNTIME_NODE_LIST,
  EMPTY_FLEET_MODELS,
  EMPTY_RELAY_CONFIG,
  EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
  EMPTY_RUNTIME_PROVISION_LIST,
  EMPTY_RUNTIME_PROVISION_STATES,
  EMPTY_RETIRE_DAEMON_RESPONSE,
  EMPTY_SSH_MESH_OVERVIEW,
  FleetModelsResponseSchema,
  type RelayConfigResponse,
  RelayConfigResponseSchema,
  RuntimeDirectoryScanRequestSchema,
  RuntimeProvisionListResponseSchema,
  RuntimeProvisionResponseSchema,
  RuntimeProvisionStatesResponseSchema,
  RuntimeHourlyActivityListSchema,
  RuntimeUsageByAgentListSchema,
  RuntimeUsageByHourListSchema,
  RuntimeUsageListSchema,
  RetireDaemonResponseSchema,
  SshMeshOverviewSchema,
  SshMeshTestResponseSchema,
} from "../schemas/runtimes";

export class RuntimesEndpoints {
  constructor(readonly http: HttpClient) {}

  async listRuntimes(params?: { workspace_id?: string; owner?: "me" }): Promise<AgentRuntime[]> {
    const search = new URLSearchParams();
    if (params?.workspace_id) search.set("workspace_id", params.workspace_id);
    if (params?.owner) search.set("owner", params.owner);
    return this.http.fetch(`/api/runtimes?${search}`);
  }

  // Fleet-level model catalog: the union of the online runtimes' models,
  // grouped by provider, with online-capacity counts. Powers the
  // machine-less agent creation flow (engine toggle + model dropdown).
  async listFleetModels(params?: { workspace_id?: string }): Promise<FleetModelsResponse> {
    const search = new URLSearchParams();
    if (params?.workspace_id) search.set("workspace_id", params.workspace_id);
    const query = search.toString();
    const raw = await this.http.fetch<unknown>(`/api/models${query ? `?${query}` : ""}`);
    return parseWithFallback(raw, FleetModelsResponseSchema, EMPTY_FLEET_MODELS, {
      endpoint: "GET /api/models",
    });
  }

  // Model gateway: fleet-wide relay config (owner/admin only). Tokens are masked
  // (hasToken boolean); the fragment is non-secret and returned in full.
  async getRelayConfig(workspaceId: string): Promise<RelayConfigResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/relay-config`);
    return parseWithFallback(raw, RelayConfigResponseSchema, EMPTY_RELAY_CONFIG, {
      endpoint: "GET /api/workspaces/:id/relay-config",
    });
  }

  async updateRelayConfig(
    workspaceId: string,
    engine: "claude" | "codex",
    data: { fragment: string; token_op: "keep" | "set" | "clear"; auth_token?: string },
  ): Promise<RelayConfigResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/relay-config/${engine}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, RelayConfigResponseSchema, EMPTY_RELAY_CONFIG, {
      endpoint: "PUT /api/workspaces/:id/relay-config/:engine",
    });
  }

  async revealRelayToken(workspaceId: string, engine: "claude" | "codex"): Promise<string> {
    const raw = await this.http.fetch<{ token?: unknown }>(
      `/api/workspaces/${workspaceId}/relay-config/${engine}/reveal`,
      { method: "POST" },
    );
    return typeof raw?.token === "string" ? raw.token : "";
  }

  async setRelayDiscovery(workspaceId: string, enabled: boolean): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/relay-config/discovery`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  }

  async listCloudRuntimeNodes(
    params?: ListCloudRuntimeNodesParams,
  ): Promise<CloudRuntimeNode[]> {
    const search = new URLSearchParams();
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.offset !== undefined) search.set("offset", String(params.offset));
    const query = search.toString();
    const raw = await this.http.fetch<unknown>(
      `/api/cloud-runtime/nodes${query ? `?${query}` : ""}`,
    );
    return parseWithFallback(
      raw,
      CloudRuntimeNodeListSchema,
      EMPTY_CLOUD_RUNTIME_NODE_LIST,
      { endpoint: "GET /api/cloud-runtime/nodes" },
    );
  }

  async createCloudRuntimeNode(
    data: CreateCloudRuntimeNodeRequest,
  ): Promise<CloudRuntimeNode> {
    const res = await this.http.fetchRaw("/api/cloud-runtime/nodes", {
      method: "POST",
      body: JSON.stringify(data),
      extraHeaders: { "Content-Type": "application/json" },
    });
    const raw = await res.json() as unknown;
    return parseWithFallback(
      raw,
      CloudRuntimeNodeSchema,
      EMPTY_CLOUD_RUNTIME_NODE,
      { endpoint: "POST /api/cloud-runtime/nodes" },
    );
  }

  async deleteCloudRuntimeNode(instanceId: string): Promise<void> {
    await this.http.fetchRaw("/api/cloud-runtime/nodes", {
      method: "DELETE",
      body: JSON.stringify({ instance_id: instanceId }),
      extraHeaders: { "Content-Type": "application/json" },
    });
  }

  async deleteRuntime(runtimeId: string): Promise<void> {
    await this.http.fetch(`/api/runtimes/${runtimeId}`, { method: "DELETE" });
  }

  async getDaemonInventory(workspaceId: string): Promise<DaemonInventoryResponse> {
    const search = new URLSearchParams({ workspace_id: workspaceId });
    const raw = await this.http.fetch<unknown>(
      `/api/multiremi/daemons?${search}`,
    );
    const response = parseWithFallback(
      raw,
      DaemonInventoryResponseSchema,
      EMPTY_DAEMON_INVENTORY_RESPONSE,
      { endpoint: "GET /api/multiremi/daemons" },
    );
    return response.workspace_id === workspaceId
      ? response
      : EMPTY_DAEMON_INVENTORY_RESPONSE;
  }

  async getDaemonRetirementPlan(
    workspaceId: string,
    daemonId: string,
  ): Promise<DaemonRetirementPlan> {
    const search = new URLSearchParams({ workspace_id: workspaceId });
    const raw = await this.http.fetch<unknown>(
      `/api/multiremi/daemons/${encodeURIComponent(daemonId)}/retirement-plan?${search}`,
    );
    const response = parseWithFallback(
      raw,
      DaemonRetirementPlanResponseSchema,
      EMPTY_DAEMON_RETIREMENT_PLAN_RESPONSE,
      { endpoint: "GET /api/multiremi/daemons/:daemonId/retirement-plan" },
    ).plan;
    if (response.workspace_id !== workspaceId || response.daemon_id !== daemonId) {
      return EMPTY_DAEMON_RETIREMENT_PLAN_RESPONSE.plan;
    }
    return response;
  }

  async retireDaemon(
    workspaceId: string,
    daemonId: string,
    expectedSnapshot: string,
    abandonIssueWorkspaces = false,
  ): Promise<RetireDaemonResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/multiremi/daemons/${encodeURIComponent(daemonId)}/retire`,
      {
        method: "POST",
        body: JSON.stringify({
          workspace_id: workspaceId,
          expected_snapshot: expectedSnapshot,
          ...(abandonIssueWorkspaces
            ? { abandon_issue_workspaces: true }
            : {}),
        }),
      },
    );
    const response = parseWithFallback(
      raw,
      RetireDaemonResponseSchema,
      EMPTY_RETIRE_DAEMON_RESPONSE,
      { endpoint: "POST /api/multiremi/daemons/:daemonId/retire" },
    );
    if (
      response.workspace_id !== workspaceId ||
      response.daemon_id !== daemonId ||
      response.retired_at.length === 0
    ) {
      return EMPTY_RETIRE_DAEMON_RESPONSE;
    }
    return response;
  }

  async getSshMeshOverview(workspaceId: string): Promise<SshMeshOverview> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/ssh-mesh`,
    );
    const response = parseWithFallback(
      raw,
      SshMeshOverviewSchema,
      EMPTY_SSH_MESH_OVERVIEW,
      { endpoint: "GET /api/workspaces/:id/ssh-mesh" },
    );
    return response.workspace_id === workspaceId
      ? response
      : EMPTY_SSH_MESH_OVERVIEW;
  }

  async listRuntimeProvisions(workspaceId: string): Promise<RuntimeProvision[]> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-provisions`,
    );
    const response = parseWithFallback(
      raw,
      RuntimeProvisionListResponseSchema,
      EMPTY_RUNTIME_PROVISION_LIST,
      { endpoint: "GET /api/workspaces/:id/runtime-provisions" },
    );
    return response.provisions.filter((provision) => provision.workspace_id === workspaceId);
  }

  async listRuntimeProvisionStates(
    workspaceId: string,
    provisionId: string,
  ): Promise<RuntimeProvisionState[]> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-provisions/${encodeURIComponent(provisionId)}/states`,
    );
    const response = parseWithFallback(
      raw,
      RuntimeProvisionStatesResponseSchema,
      EMPTY_RUNTIME_PROVISION_STATES,
      { endpoint: "GET /api/workspaces/:id/runtime-provisions/:provisionId/states" },
    );
    return response.states.filter((state) => state.provision_id === provisionId);
  }

  async createRuntimeProvision(
    workspaceId: string,
    input: RuntimeProvisionInput,
  ): Promise<RuntimeProvision> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-provisions`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const response = parseStrictResponse<import("../../runtimes/types").RuntimeProvisionResponse>(
      raw,
      RuntimeProvisionResponseSchema,
      { endpoint: "POST /api/workspaces/:id/runtime-provisions" },
    );
    if (!response.provision.id || response.provision.workspace_id !== workspaceId) {
      throw new ApiContractError(
        "POST /api/workspaces/:id/runtime-provisions",
        "Runtime provision response does not match the requested workspace",
      );
    }
    return response.provision;
  }

  async updateRuntimeProvision(
    workspaceId: string,
    provisionId: string,
    input: RuntimeProvisionInput,
  ): Promise<RuntimeProvision> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-provisions/${encodeURIComponent(provisionId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    const response = parseStrictResponse<import("../../runtimes/types").RuntimeProvisionResponse>(
      raw,
      RuntimeProvisionResponseSchema,
      { endpoint: "PATCH /api/workspaces/:id/runtime-provisions/:provisionId" },
    );
    if (response.provision.id !== provisionId || response.provision.workspace_id !== workspaceId) {
      throw new ApiContractError(
        "PATCH /api/workspaces/:id/runtime-provisions/:provisionId",
        "Runtime provision response does not match the requested declaration",
      );
    }
    return response.provision;
  }

  async deleteRuntimeProvision(workspaceId: string, provisionId: string): Promise<void> {
    await this.http.fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-provisions/${encodeURIComponent(provisionId)}`,
      { method: "DELETE" },
    );
  }

  async setSshMeshEnabled(
    workspaceId: string,
    enabled: boolean,
    options?: { invalidateKeys?: boolean },
  ): Promise<SshMeshOverview> {
    const invalidateKeys = options?.invalidateKeys === true;
    if (enabled && invalidateKeys) {
      throw new TypeError("SSH Mesh keys can only be invalidated while disabling");
    }
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/ssh-mesh`,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          ...(invalidateKeys ? { invalidate_keys: true } : {}),
        }),
      },
    );
    const endpoint = "PUT /api/workspaces/:id/ssh-mesh";
    const response = parseStrictResponse<SshMeshOverview>(
      raw,
      SshMeshOverviewSchema,
      { endpoint },
    );
    const responseMatchesCommand = invalidateKeys
      ? response.workspace_id === workspaceId &&
        response.enabled === false &&
        response.rotation_state === "rekey_required" &&
        response.fingerprint === null
      : response.workspace_id === workspaceId &&
        response.enabled === enabled &&
        response.rotation_state === "stable" &&
        (!enabled || (response.key_version > 0 && !!response.fingerprint));
    if (!responseMatchesCommand) {
      throw new ApiContractError(endpoint, "SSH Mesh state did not match the requested update");
    }
    return response;
  }

  async rotateSshMeshKey(workspaceId: string): Promise<SshMeshOverview> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/ssh-mesh/rotate`,
      { method: "POST" },
    );
    const endpoint = "POST /api/workspaces/:id/ssh-mesh/rotate";
    const response = parseStrictResponse<SshMeshOverview>(
      raw,
      SshMeshOverviewSchema,
      { endpoint },
    );
    if (
      response.workspace_id !== workspaceId ||
      !response.enabled ||
      response.key_version <= 0 ||
      !response.fingerprint ||
      (response.rotation_state !== "rolling_out" && response.rotation_state !== "stable")
    ) {
      throw new ApiContractError(endpoint, "SSH Mesh state did not confirm key rotation");
    }
    return response;
  }

  async testSshMeshConnection(
    workspaceId: string,
    sourceDaemonId: string,
    targetDaemonId?: string,
  ): Promise<SshMeshTestResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${workspaceId}/ssh-mesh/test`,
      {
        method: "POST",
        body: JSON.stringify({
          source_daemon_id: sourceDaemonId,
          ...(targetDaemonId ? { target_daemon_id: targetDaemonId } : {}),
        }),
      },
    );
    return parseStrictResponse<SshMeshTestResponse>(
      raw,
      SshMeshTestResponseSchema,
      { endpoint: "POST /api/workspaces/:id/ssh-mesh/test" },
    );
  }

  // Cascade variant of deleteRuntime. The strict DELETE refuses with
  // structured 409 (`code: "runtime_has_active_agents"`, body carries the
  // blocking agents) when active agents are bound; the front-end then opens
  // the cascade-mode confirmation dialog and submits the user-confirmed
  // active agent set here. Server compares the snapshot to the live set
  // inside the transaction and refuses with `code: "runtime_delete_plan_changed"`
  // (same shape, fresh `active_agents`) if they don't match — caller should
  // re-render the agent list and force the user to re-confirm.
  async archiveAgentsAndDeleteRuntime(
    runtimeId: string,
    expectedActiveAgentIds: string[],
  ): Promise<{ status: string; agents_archived: number; tasks_cancelled: number }> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/archive-agents-and-delete`, {
      method: "POST",
      body: JSON.stringify({ expected_active_agent_ids: expectedActiveAgentIds }),
    });
  }

  async updateRuntime(
    runtimeId: string,
    patch: { visibility?: "private" | "public"; name?: string },
  ): Promise<AgentRuntime> {
    return this.http.fetch(`/api/runtimes/${runtimeId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async getRuntimeUsage(
    runtimeId: string,
    params?: { days?: number; tz?: string },
  ): Promise<RuntimeUsage[]> {
    const search = new URLSearchParams();
    if (params?.days) search.set("days", String(params.days));
    // `tz` drives the calendar-day boundary for the trend chart (Viewing
    // layer). Caller-supplied; the backend falls back to user.timezone /
    // UTC if omitted.
    if (params?.tz) search.set("tz", params.tz);
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${runtimeId}/usage?${search}`,
    );
    // Strict (MUL-93): a drifted body throws ApiContractError instead of
    // degrading to [] — an empty array from here always means a real zero.
    return parseStrictResponse<RuntimeUsage[]>(raw, RuntimeUsageListSchema, {
      endpoint: "GET /api/runtimes/:id/usage",
    });
  }

  async getRuntimeTaskActivity(
    runtimeId: string,
    params?: { tz?: string },
  ): Promise<RuntimeHourlyActivity[]> {
    // Hour-of-day heatmap follows the viewer's tz, like the other reports on
    // this page. Pass the viewer's IANA zone so the server buckets correctly.
    const search = new URLSearchParams();
    if (params?.tz) search.set("tz", params.tz);
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${runtimeId}/activity?${search}`,
    );
    return parseWithFallback<RuntimeHourlyActivity[]>(
      raw,
      RuntimeHourlyActivityListSchema,
      [],
      { endpoint: "GET /api/runtimes/:id/activity" },
    );
  }

  async getLatestCliVersion(): Promise<string | null> {
    const raw = await this.http.fetch<unknown>(`/api/cli/latest-version`);
    const parsed = parseWithFallback<CliLatestVersionResponse>(
      raw,
      CliLatestVersionResponseSchema,
      EMPTY_CLI_LATEST_VERSION,
      { endpoint: "GET /api/cli/latest-version" },
    );
    return parsed.version ?? null;
  }

  async getRuntimeUsageByAgent(
    runtimeId: string,
    params?: { days?: number; tz?: string },
  ): Promise<RuntimeUsageByAgent[]> {
    const search = new URLSearchParams();
    if (params?.days) search.set("days", String(params.days));
    if (params?.tz) search.set("tz", params.tz);
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${runtimeId}/usage/by-agent?${search}`,
    );
    // Strict (MUL-93) — see getRuntimeUsage.
    return parseStrictResponse<RuntimeUsageByAgent[]>(
      raw,
      RuntimeUsageByAgentListSchema,
      { endpoint: "GET /api/runtimes/:id/usage/by-agent" },
    );
  }

  async getRuntimeUsageByHour(
    runtimeId: string,
    params?: { days?: number; tz?: string },
  ): Promise<RuntimeUsageByHour[]> {
    const search = new URLSearchParams();
    if (params?.days) search.set("days", String(params.days));
    if (params?.tz) search.set("tz", params.tz);
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${runtimeId}/usage/by-hour?${search}`,
    );
    return parseWithFallback<RuntimeUsageByHour[]>(
      raw,
      RuntimeUsageByHourListSchema,
      [],
      { endpoint: "GET /api/runtimes/:id/usage/by-hour" },
    );
  }

  async initiateUpdate(
    runtimeId: string,
    targetVersion: string,
    scope?: "cli" | "acp" | "agent",
  ): Promise<RuntimeUpdate> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/update`, {
      method: "POST",
      body: JSON.stringify({ target_version: targetVersion, scope }),
    });
  }

  async getUpdateResult(
    runtimeId: string,
    updateId: string,
  ): Promise<RuntimeUpdate> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/update/${updateId}`);
  }

  async initiateListModels(runtimeId: string): Promise<RuntimeModelListRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/models`, { method: "POST" });
  }

  async getListModelsResult(
    runtimeId: string,
    requestId: string,
  ): Promise<RuntimeModelListRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/models/${requestId}`);
  }

  async initiateListLocalSkills(
    runtimeId: string,
  ): Promise<RuntimeLocalSkillListRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/local-skills`, {
      method: "POST",
    });
  }

  async getListLocalSkillsResult(
    runtimeId: string,
    requestId: string,
  ): Promise<RuntimeLocalSkillListRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/local-skills/${requestId}`);
  }

  async initiateImportLocalSkill(
    runtimeId: string,
    data: CreateRuntimeLocalSkillImportRequest,
  ): Promise<RuntimeLocalSkillImportRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/local-skills/import`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getImportLocalSkillResult(
    runtimeId: string,
    requestId: string,
  ): Promise<RuntimeLocalSkillImportRequest> {
    return this.http.fetch(`/api/runtimes/${runtimeId}/local-skills/import/${requestId}`);
  }

  async initiateDirectoryScan(
    runtimeId: string,
    body?: CreateRuntimeDirectoryScanRequest,
  ): Promise<RuntimeDirectoryScanRequest> {
    const raw = await this.http.fetch<unknown>(`/api/runtimes/${runtimeId}/directory-scans`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    return parseWithFallback<RuntimeDirectoryScanRequest>(
      raw,
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      { endpoint: "POST /api/runtimes/:id/directory-scans" },
    );
  }

  async getDirectoryScanResult(
    runtimeId: string,
    requestId: string,
  ): Promise<RuntimeDirectoryScanRequest> {
    const raw = await this.http.fetch<unknown>(
      `/api/runtimes/${runtimeId}/directory-scans/${requestId}`,
    );
    return parseWithFallback<RuntimeDirectoryScanRequest>(
      raw,
      RuntimeDirectoryScanRequestSchema,
      EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST,
      { endpoint: "GET /api/runtimes/:id/directory-scans/:requestId" },
    );
  }
}
