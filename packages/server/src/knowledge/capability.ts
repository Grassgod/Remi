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
  return agentKnowledgePublishPluginNames(reader, agent).length > 0;
}

/** Enabled provider plugins that grant the Agent knowledge publish authority. */
export function agentKnowledgePublishPluginNames(
  reader: KnowledgePublishCapabilityReader,
  agent: MultiremiAgent,
): string[] {
  if (!agentRoleAtLeast(agent.role, "maintainer")) return [];
  const allowedNames = new Set<string>(KNOWLEDGE_PUBLISH_PLUGIN_NAMES);
  const pluginsById = new Map(
    reader.listAgentPlugins(agent.workspaceId, {
      provider: agent.provider,
      includeArchived: false,
    })
      .filter((plugin) => allowedNames.has(plugin.name))
      .map((plugin) => [plugin.id, plugin.name] as const),
  );
  if (pluginsById.size === 0) return [];
  return [...new Set(reader.listAgentPluginBindings(agent.id)
    .filter((binding) => binding.enabled && pluginsById.has(binding.pluginId))
    .map((binding) => pluginsById.get(binding.pluginId)!))];
}
