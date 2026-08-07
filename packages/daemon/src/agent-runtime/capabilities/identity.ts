import type { RemiConfig } from "@shared/config.js";
import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";

export const identityBlock: CapabilityBlock = {
  name: "identity",

  persistent(ctx: PersistentContext) {
    const { message, groupConfig, sessionRow } = ctx;
    // Same resolution order Remi uses to pick the provider instance
    // (group config → the session's P2P choice → default), so the model we
    // assemble belongs to the agent that will actually run the turn.
    const agentType = groupConfig?.provider ?? sessionRow?.provider ?? ctx.config.provider.default;
    return {
      agentType,
      model: agentModel(ctx.config, agentType),
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
      // "" is the stored "follow the CLI default" value — never send it.
      effort: agent?.thinkingLevel || null,
      chatId: task.id,
      sessionId: task.sessionId ?? undefined,
      allowedTools: agent?.allowedTools?.length ? agent.allowedTools : undefined,
      signal,
    };
  },
};

/** Model configured for an agent type in remi.toml (mirrors Remi._buildProvider). */
function agentModel(config: RemiConfig, agentType: string): string | null {
  const type = agentType.startsWith("acp:") ? agentType.slice("acp:".length) : agentType;
  const agentCfg = type === "codex" ? config.provider.codex : config.provider.claude;
  return agentCfg?.model ?? null;
}
