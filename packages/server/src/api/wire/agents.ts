// Wire serializers for the agents domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type { MultiremiAgent } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import {
  cleanString,
  currentRequestUserId,
  currentWorkspaceRoleStrict,
  workspaceAlwaysRedactSecrets,
} from "./context.js";
import { agentSkillCompatibilitySummary, daemonClaimSkillResponse } from "./skills.js";

export function agentCompatibilityResponse(store: MultiremiStore, agent: MultiremiAgent, c?: any): Record<string, unknown> {
  const customEnvKeyCount = Object.keys(agent.customEnv ?? {}).length;
  const mcpConfig = agentMcpConfigForRequest(store, agent, c);
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    runtime_id: agent.runtimeId ?? "",
    provider: agent.provider,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    avatar_url: agent.avatarUrl,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: agent.customArgs ?? [],
    mcp_config: mcpConfig.value,
    has_custom_env: customEnvKeyCount > 0,
    custom_env_key_count: customEnvKeyCount,
    mcp_config_redacted: mcpConfig.redacted,
    visibility: agent.visibility,
    status: agent.archivedAt ? "archived" : "active",
    max_concurrent_tasks: agent.maxConcurrentTasks,
    model: agent.model ?? "",
    thinking_level: agent.thinkingLevel ?? "",
    issue_creation_requires_proposal: agent.issueCreationRequiresProposal,
    role: agent.role,
    supervisor: agent.supervisor === true,
    owner_id: agent.ownerId,
    skills: store.listAgentSkills(agent.id, { includeFiles: false }).map(agentSkillCompatibilitySummary),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    archived_at: agent.archivedAt,
    archived_by: null,
  };
}

export function agentBroadcastCompatibilityResponse(store: MultiremiStore, agent: MultiremiAgent): Record<string, unknown> {
  const response = agentCompatibilityResponse(store, agent);
  if (response.mcp_config != null) {
    response.mcp_config = null;
    response.mcp_config_redacted = true;
  }
  return response;
}

function agentMcpConfigForRequest(
  store: MultiremiStore,
  agent: MultiremiAgent,
  c?: any,
): { value: unknown | null; redacted: boolean } {
  if (agent.mcpConfig == null) return { value: null, redacted: false };
  if (!c) return { value: agent.mcpConfig, redacted: false };
  if (cleanString(c.req?.header?.("X-Agent-ID"))) return { value: null, redacted: true };
  if (workspaceAlwaysRedactSecrets(store.getWorkspace(agent.workspaceId)?.settings)) return { value: null, redacted: true };
  const role = currentWorkspaceRoleStrict(c, store, agent.workspaceId);
  if (role === "owner" || role === "admin" || agent.ownerId === currentRequestUserId(c)) {
    return { value: agent.mcpConfig, redacted: false };
  }
  return { value: null, redacted: true };
}

export function agentEnvResponse(agentId: string, env: Record<string, string>): {
  agent_id: string;
  custom_env: Record<string, string>;
} {
  return {
    agent_id: agentId,
    custom_env: { ...env },
  };
}

export function daemonClaimAgentResponse(agent: MultiremiAgent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    instructions: agent.instructions,
    skills: agent.skills.map(daemonClaimSkillResponse),
    custom_env: agent.customEnv ?? {},
    custom_args: agent.customArgs ?? [],
    mcp_config: agent.mcpConfig,
    model: agent.model ?? "",
    thinking_level: agent.thinkingLevel ?? "",
    cwd: agent.cwd ?? "",
    executable: agent.executable ?? "",
    allowed_tools: agent.allowedTools ?? [],
    max_concurrent_tasks: agent.maxConcurrentTasks,
  };
}

export function daemonBotAgentResponse(agent: MultiremiAgent): Record<string, unknown> {
  return {
    ...daemonClaimAgentResponse(agent),
    description: agent.description,
    avatar_url: agent.avatarUrl,
    workspace_id: agent.workspaceId,
    owner_id: agent.ownerId,
    visibility: agent.visibility,
    runtime_id: agent.runtimeId,
    issue_creation_requires_proposal: agent.issueCreationRequiresProposal,
    supervisor: agent.supervisor === true,
    archived_at: agent.archivedAt,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}
