import type {
  MultiremiAgent,
  MultiremiAgentPlugin,
  MultiremiAgentPluginBinding,
} from "@multiremi/contracts/types.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";

export const KNOWLEDGE_PUBLISH_PLUGIN_NAMES = ["code-to-wiki"] as const;

export interface KnowledgePublishCapabilityReader {
  listAgentPlugins(
    workspaceId: string,
    options?: { provider?: string | null; includeArchived?: boolean },
  ): MultiremiAgentPlugin[];
  listAgentPluginBindings(agentId: string): MultiremiAgentPluginBinding[];
}

/** Publish authority is platform configuration, never an Agent display name. */
export function agentHasKnowledgePublishCapability(
  reader: KnowledgePublishCapabilityReader,
  agent: MultiremiAgent,
): boolean {
  if (!agentRoleAtLeast(agent.role, "maintainer")) return false;
  const allowedNames = new Set<string>(KNOWLEDGE_PUBLISH_PLUGIN_NAMES);
  const pluginIds = new Set(
    reader.listAgentPlugins(agent.workspaceId, {
      provider: agent.provider,
      includeArchived: false,
    })
      .filter((plugin) => allowedNames.has(plugin.name))
      .map((plugin) => plugin.id),
  );
  if (pluginIds.size === 0) return false;
  return reader.listAgentPluginBindings(agent.id).some((binding) =>
    binding.enabled && pluginIds.has(binding.pluginId)
  );
}
