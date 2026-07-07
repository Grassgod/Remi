import type { CapabilityBlock, PersistentContext } from "../types.js";

export const promptsBlock: CapabilityBlock = {
  name: "prompts",

  persistent(ctx: PersistentContext) {
    const { message, groupConfig, memory } = ctx;

    const chatMeta = groupConfig?.injectChatContext
      ? `\n[chat_context] chatId=${message.chatId} sender=${message.sender} senderOpenId=${message.metadata?.senderOpenId ?? "unknown"}`
      : "";

    const memoryContext = memory.readMemory().trim();

    const promptParts = [
      memoryContext ? `# Memory\n${memoryContext}` : "",
      groupConfig?.systemPrompt ?? "",
      chatMeta,
    ].filter(Boolean);

    const systemPrompt = promptParts.length ? promptParts.join("\n\n") : undefined;

    return {
      systemPrompt,
      context: memoryContext || undefined,
    };
  },
};
