import type {
  MultiremiAgent,
  MultiremiAgentPlugin,
  MultiremiAgentPluginBinding,
  MultiremiAutopilot,
  MultiremiAutopilotTrigger,
} from "@multiremi/contracts/types.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";

export interface RepositoryWikiAutomationReader {
  listAgents(): MultiremiAgent[];
  listAutopilots(workspaceId: string): MultiremiAutopilot[];
  listAgentPlugins(
    workspaceId: string,
    options?: { provider?: string | null; includeArchived?: boolean },
  ): MultiremiAgentPlugin[];
  listAgentPluginBindings(agentId: string): MultiremiAgentPluginBinding[];
  listAutopilotTriggers(autopilotId: string): MultiremiAutopilotTrigger[];
}

/**
 * Resolve repository Wiki behavior from normal platform configuration. There
 * is no privileged name or hidden managed kind: the Agent, plugin binding and
 * SCM automation are the complete source of truth.
 */
export function resolveRepositoryWikiAutomation(
  reader: RepositoryWikiAutomationReader,
  workspaceId: string,
): MultiremiAutopilot | null {
  const pluginIds = new Set(
    reader.listAgentPlugins(workspaceId, { provider: "claude" })
      .filter((plugin) => plugin.name === "code-to-wiki")
      .map((plugin) => plugin.id),
  );
  if (pluginIds.size === 0) return null;

  const capableAgentIds = new Set(
    reader.listAgents()
      .filter((agent) =>
        agent.workspaceId === workspaceId
        && agent.provider === "claude"
        && agentRoleAtLeast(agent.role, "maintainer")
      )
      .filter((agent) => reader.listAgentPluginBindings(agent.id).some((binding) =>
        binding.enabled && pluginIds.has(binding.pluginId)
      ))
      .map((agent) => agent.id),
  );
  if (capableAgentIds.size === 0) return null;

  return reader.listAutopilots(workspaceId).find((autopilot) =>
    autopilot.status === "active"
    && autopilot.executionMode === "run_only"
    && autopilot.assigneeType === "agent"
    && capableAgentIds.has(autopilot.assigneeId)
    && reader.listAutopilotTriggers(autopilot.id).some((trigger) =>
      trigger.enabled && trigger.kind === "scm_event"
    )
  ) ?? null;
}
