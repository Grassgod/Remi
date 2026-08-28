import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const workspaceBlock: CapabilityBlock = {
  name: "workspace",

  persistent(ctx: PersistentContext) {
    const cwd = ctx.sessionRow?.cwd?.trim() || ctx.agent.cwd?.trim() || ctx.topicCwd?.trim();
    if (!cwd) {
      throw new Error(`Bot agent ${ctx.agent.id} has no cwd configured`);
    }
    return { cwd };
  },

  ephemeral(ctx: EphemeralContext) {
    return { cwd: ctx.workDir };
  },
};
