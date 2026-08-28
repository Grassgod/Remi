import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const identityBlock: CapabilityBlock = {
  name: "identity",

  persistent(ctx: PersistentContext) {
    const { message, sessionRow, agent } = ctx;
    return {
      agentType: agent.provider,
      executable: agent.executable ?? undefined,
      customArgs: agent.customArgs,
      model: agent.model,
      effort: agent.thinkingLevel || null,
      chatId: ctx.sessionKey,
      sessionId: sessionRow?.session_id || undefined,
      media: message.media,
      allowedTools: agent.allowedTools.length ? agent.allowedTools : undefined,
      traceId: (message.metadata?.messageId as string) ?? undefined,
    };
  },

  ephemeral(ctx: EphemeralContext) {
    const { task, signal } = ctx;
    const agent = task.agent;
    return {
      agentType: agent?.provider ?? "claude",
      executable: agent?.executable ?? undefined,
      customArgs: agent?.customArgs ?? [],
      model: agent?.model ?? null,
      // "" is the stored "follow the CLI default" value — never send it.
      effort: agent?.thinkingLevel || null,
      chatId: task.id,
      sessionId: task.sessionId ?? undefined,
      allowedTools: agent?.allowedTools?.length ? agent.allowedTools : undefined,
      signal,
    };
  },
};
