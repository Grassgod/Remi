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
    const topicCapability = [
      "# Feishu topic workspaces",
      "When `remi issue create` reports `topic_migration`, explicitly tell the user that the topic moved to the reported Issue workspace path.",
      "Use `--no-bind-topic` only when the user wants an Issue created without handing the current topic over to it.",
    ].join("\n");
    return {
      systemPrompt: [instructions, memoryCapability, topicCapability].filter(Boolean).join("\n\n"),
    };
  },
};
