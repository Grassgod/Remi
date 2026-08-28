import type { CapabilityBlock, PersistentContext, EphemeralContext, RecoveryConfig } from "../types.js";

export const permissionsBlock: CapabilityBlock = {
  name: "permissions",

  persistent(ctx: PersistentContext) {
    const recovery: RecoveryConfig = {
      retryOnStaleSession: true,
      retryOnPromptTooLong: true,
    };
    return {
      permissionMode: ctx.sessionRow?.mode ?? null,
      recovery,
    };
  },

  ephemeral(ctx: EphemeralContext) {
    return {
      // "ask" keeps the agent's own permission gate active so requests reach
      // the daemon's permission handler (routed to a human via the server).
      permissionMode: ctx.approvalMode === "ask" ? "default" : ("bypassPermissions" as const),
    };
  },
};
