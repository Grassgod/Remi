import type { ChatMessage } from "@multiremi/core/types";

/**
 * Markdown the Copy action puts on the clipboard: the reply itself. A Chat
 * reply row carries the turn's `final_reply_md` (the trace's final item, chosen
 * once by the daemon), so copying never depends on the trace being online and
 * never picks up the steps folded above the reply.
 */
export function extractCopyText(message: Pick<ChatMessage, "content">): string {
  return message.content ?? "";
}
