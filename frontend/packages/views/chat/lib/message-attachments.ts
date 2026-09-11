import type { ChatMessage } from "@multiremi/core/types";

/**
 * Authenticated file endpoints are rendered from their attachment records.
 * The shared Markdown file-card parser accepts only upload/CDN URLs; leaving
 * these markers inline would both display raw syntax and hide the fallback
 * attachment card through URL deduplication.
 */
export function chatMessageMarkdown(
  message: Pick<ChatMessage, "content" | "attachments">,
): string {
  const attachedUrls = new Set(
    message.attachments?.map((attachment) => attachment.url),
  );
  return message.content
    .replace(
      /^!file\[(?:\\.|[^\]])*\]\((\/api\/attachments\/[^/?)]+\/content(?:\?[^)]*)?)\)[ \t]*$/gm,
      (marker, url: string) => (attachedUrls.has(url) ? "" : marker),
    )
    .trim();
}
