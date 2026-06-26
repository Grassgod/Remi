import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const identityBlock: CapabilityBlock = {
  name: "identity",

  persistent(ctx: PersistentContext) {
    const { message, groupConfig, sessionRow } = ctx;
    const agentType = groupConfig?.provider ?? ctx.config.provider.default;
    return {
      agentType,
      model: null,
      chatId: ctx.sessionKey,
      sessionId: sessionRow?.session_id || undefined,
      media: message.media,
      allowedTools: groupConfig?.allowedTools?.length ? groupConfig.allowedTools : undefined,
      addDirs: groupConfig?.addDirs?.length ? groupConfig.addDirs : undefined,
      traceId: (message.metadata?.messageId as string) ?? undefined,
    };
  },

  ephemeral(ctx: EphemeralContext) {
    const { task, signal } = ctx;
    const agent = task.agent;
    return {
      agentType: agent?.provider ?? "claude",
      executable: agent?.executable ?? undefined,
      model: agent?.model ?? null,
      chatId: task.id,
      sessionId: task.sessionId ?? undefined,
      allowedTools: agent?.allowedTools?.length ? agent.allowedTools : undefined,
      signal,
    };
  },
};
