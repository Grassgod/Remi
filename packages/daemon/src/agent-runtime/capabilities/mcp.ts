import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";
import type { AcpMcpServer } from "../mcp/ephemeral.js";
import { buildTaskMcpServers } from "../mcp/ephemeral.js";
import type { McpServerEntry } from "@shared/config.js";

export const mcpBlock: CapabilityBlock = {
  name: "mcp",

  persistent(ctx: PersistentContext) {
    const agentType = ctx.groupConfig?.provider ?? ctx.config.provider.default;
    return { mcpServers: configMcpToAcp(ctx.config.mcp, agentType) };
  },

  ephemeral(ctx: EphemeralContext) {
    return { mcpServers: buildTaskMcpServers(ctx.task) };
  },
};

/**
 * remi.toml keeps the ergonomic Record env; the ACP wire form is
 * `EnvVariable[]` with `args`/`env` both required — see {@link AcpMcpServer}.
 */
function configMcpToAcp(entries: McpServerEntry[], agentType: string): AcpMcpServer[] {
  return entries
    .filter((e) => !e.agents || e.agents.includes(agentType))
    .map((e) => ({
      name: e.name,
      command: e.command,
      args: e.args ?? [],
      env: Object.entries(e.env ?? {}).map(([name, value]) => ({ name, value })),
    }));
}
