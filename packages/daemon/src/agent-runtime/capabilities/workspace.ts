import { homedir } from "node:os";
import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const workspaceBlock: CapabilityBlock = {
  name: "workspace",

  persistent(ctx: PersistentContext) {
    const { message, groupConfig, sessionRow } = ctx;
    const cwd =
      groupConfig?.cwd ||
      groupConfig?.projectCwd ||
      sessionRow?.cwd ||
      (message.metadata?.cwd as string) ||
      homedir();
    return { cwd };
  },

  ephemeral(ctx: EphemeralContext) {
    return { cwd: ctx.workDir };
  },
};
