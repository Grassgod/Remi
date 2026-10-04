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

/**
 * True for a side-channel assistant message: the agent pushed attachments
 * mid-run (SendChatAttachments), so the row carries the *running* task's id
 * even though the task has produced no reply yet.
 *
 * One task id now maps to several assistant rows — N of these, then exactly
 * one terminal reply written by CompleteTask/FailTask. The two must render
 * differently: a side-channel row owns its own caption plus its attachment
 * cards, while only the terminal row owns the task timeline. Telling them
 * apart keeps the live status pill up until the real reply lands, keeps the
 * caption from being replaced by the timeline, and keeps that timeline from
 * being drawn twice once the task finishes.
 *
 * The terminal row is identified by what only CompleteTask/FailTask set:
 * `elapsed_ms` (a measured wall-clock duration) or `failure_reason`.
 * Attachments are required too, so pre-migration-063 rows — legacy replies
 * with neither field — keep classifying as ordinary replies.
 */
export function isAgentAttachmentMessage(
  message: Pick<
    ChatMessage,
    "role" | "task_id" | "attachments" | "elapsed_ms" | "failure_reason"
  >,
): boolean {
  return (
    message.role === "assistant" &&
    !!message.task_id &&
    !!message.attachments?.length &&
    message.elapsed_ms == null &&
    !message.failure_reason
  );
}
