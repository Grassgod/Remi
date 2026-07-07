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

function configMcpToAcp(entries: McpServerEntry[], agentType: string): AcpMcpServer[] {
  return entries
    .filter((e) => !e.agents || e.agents.includes(agentType))
    .map((e) => {
      const server: AcpMcpServer = { name: e.name, command: e.command };
      if (e.args) server.args = e.args;
      if (e.env) server.env = e.env;
      return server;
    });
}
