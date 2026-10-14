import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const workspaceBlock: CapabilityBlock = {
  name: "workspace",

  persistent(ctx: PersistentContext) {
    const cwd = ctx.sessionRow?.cwd?.trim() || ctx.topicCwd?.trim();
    if (!cwd) {
      throw new Error(`Persistent session for Agent ${ctx.agent.id} has no workspace`);
    }
    return { cwd };
  },

  ephemeral(ctx: EphemeralContext) {
    const addDirs = [
      ...(ctx.task.runtimeWorkspace ? [ctx.task.runtimeWorkspace.rootPath] : []),
      // Antigravity reaches only the directories it is given; the other providers are not confined to their cwd.
      ...(ctx.task.agent?.provider === "antigravity" && ctx.workspaceDir !== ctx.workDir ? [ctx.workspaceDir] : []),
    ];
    return { cwd: ctx.workDir, ...(addDirs.length ? { addDirs } : {}) };
  },
};
