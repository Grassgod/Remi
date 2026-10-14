import type { QueuedMessageErrorCode } from "@multiremi/contracts/queued-message";
import { ApiError } from "../api/http";
import type { ChatQueue, QueuedChatMessage, QueuedMessageAttachment } from "../api/schemas/chat-queue";

export type { ChatQueue, ChatQueuePause, QueuedChatMessage, QueuedMessageAttachment } from "../api/schemas/chat-queue";

/** Rows the queue still holds; released and deleted rows leave the list. */
export function isLiveQueueStatus(status: string): boolean {
  return status === "queued" || status === "failed";
}

/** The `code` of a queue route's `{error, code}` body, if the server answered. */
export function queueErrorCode(error: unknown): QueuedMessageErrorCode | (string & {}) | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * A command that failed without an HTTP status (network error, timeout, an
 * unreadable answer) may or may not have been applied. Every queue command is
 * idempotent, so a retry is safe — but it is never automatic.
 */
export function isQueueDeliveryUnconfirmed(error: unknown): boolean {
  return !(error instanceof ApiError);
}

/** The row was already released (sent) and can no longer change. */
export function isQueueConsumed(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && queueErrorCode(error) === "queued_message_consumed";
}

/** A failed steer answers 409 with the failed row; the lane is paused. */
export function queueErrorItem(error: unknown): QueuedChatMessage | null {
  if (!(error instanceof ApiError) || queueErrorCode(error) !== "queued_message_send_failed") return null;
  const item = (error.body as { item?: unknown } | undefined)?.item;
  return item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
    ? item as QueuedChatMessage : null;
}

/** Writes a command's row into the cached queue, or drops it once it left. */
export function applyQueueItem(queue: ChatQueue | undefined, item: QueuedChatMessage): ChatQueue | undefined {
  if (!queue) return queue;
  const index = queue.items.findIndex((entry) => entry.id === item.id);
  if (!isLiveQueueStatus(item.status)) {
    return index < 0 ? queue : { ...queue, items: queue.items.filter((entry) => entry.id !== item.id) };
  }
  if (index < 0) return { ...queue, items: [...queue.items, item] };
  const items = [...queue.items];
  items[index] = item;
  return { ...queue, items };
}

/** Whitespace collapsed to single spaces, as the one-line preview shows it. */
export function queuePreviewText(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** At most `max` characters, the ellipsis included (Codex: 80). */
export function truncatePreview(preview: string, max = 80): string {
  const chars = Array.from(preview);
  return chars.length <= max ? preview : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Rebuilds the composer's url → attachment id bindings for a queued body.
 * Uploads are referenced in the Markdown by their `/api/attachments/<id>/…`
 * URL; an attachment the body does not reference gets no binding, so saving
 * the edit drops it, as a send would.
 */
export function queuedAttachmentBindings(body: string, attachments: readonly QueuedMessageAttachment[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const attachment of attachments) {
    const marker = `/api/attachments/${encodeURIComponent(attachment.id)}/`;
    const at = body.indexOf(marker);
    if (at < 0) continue;
    let start = at;
    while (start > 0 && !/[\s(<"']/.test(body[start - 1]!)) start -= 1;
    let end = at + marker.length;
    while (end < body.length && !/[\s)>"']/.test(body[end]!)) end += 1;
    bindings[body.slice(start, end)] = attachment.id;
  }
  return bindings;
}
