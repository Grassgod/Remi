import type { CapabilityBlock, PersistentContext, EphemeralContext, RecoveryConfig } from "../types.js";

export const permissionsBlock: CapabilityBlock = {
  name: "permissions",

  persistent(ctx: PersistentContext) {
    const { groupConfig, sessionRow, config } = ctx;
    const agentType = groupConfig?.provider ?? config.provider.default;
    const recovery: RecoveryConfig = {
      retryOnStaleSession: true,
      retryOnPromptTooLong: true,
      fallbackAgentType: agentType === "claude" ? "codex" : null,
    };
    return {
      permissionMode: sessionRow?.mode ?? null,
      permissionHandler: null,
      elicitationHandler: null,
      recovery,
    };
  },

  ephemeral(_ctx: EphemeralContext) {
    return {
      permissionMode: "bypassPermissions" as const,
      permissionHandler: null,
      elicitationHandler: null,
    };
  },
};
