import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";
import { buildAgentMcpServers, buildTaskMcpServers } from "../mcp/ephemeral.js";

export const mcpBlock: CapabilityBlock = {
  name: "mcp",

  persistent(ctx: PersistentContext) {
    return { mcpServers: buildAgentMcpServers(ctx.agent.mcpConfig) };
  },

  ephemeral(ctx: EphemeralContext) {
    return {
      mcpServers: buildTaskMcpServers(ctx.task),
    };
  },
};
