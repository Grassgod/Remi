import type { CapabilityBlock, PersistentContext } from "../types.js";

export const promptsBlock: CapabilityBlock = {
  name: "prompts",

  persistent(ctx: PersistentContext) {
    const instructions = ctx.agent.instructions.trim();
    const memoryCapability = [
      "# Multiremi memory",
      "Project memory is authoritative in Multiremi, not in ~/.remi/memory.",
      "Use `remi memory search` before relying on remembered facts, `remi memory get` to read a hit, and `remi memory create|update` to persist durable knowledge.",
    ].join("\n");
    return {
      systemPrompt: [instructions, memoryCapability].filter(Boolean).join("\n\n"),
    };
  },
};
