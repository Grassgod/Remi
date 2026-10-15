/**
 * Chat follow-up queue (ADR 0020).
 *
 * A queued message lives outside the conversation log until it is released.
 * Release writes an ordinary member `wake=now` request through the single
 * message writer, so the cursor, barrier and next-turn rules do not change.
 */
import type { UnifiedMessage } from "./unified-model.js";

export const QUEUED_MESSAGE_STATUSES = ["queued", "failed", "released", "deleted"] as const;
export type QueuedMessageStatus = typeof QUEUED_MESSAGE_STATUSES[number];

/** `turn`: released as a follow-up while the lane was idle; `steer`: promoted by its sender. */
export const QUEUED_MESSAGE_RELEASE_VIA = ["steer", "turn"] as const;
export type QueuedMessageReleaseVia = typeof QUEUED_MESSAGE_RELEASE_VIA[number];

export const QUEUE_PAUSE_REASONS = ["interrupted", "send_failed", "turn_ended"] as const;
export type QueuePauseReason = typeof QUEUE_PAUSE_REASONS[number];

/** Live rows (`queued` and `failed`) one lane may hold. */
export const QUEUE_MAX_LIVE_ITEMS = 50;
/** Same per-message limit as a direct send. */
export const QUEUE_MAX_ATTACHMENTS = 10;
/** Release writes its message with this dedupe key prefix plus the row id. */
export const QUEUED_MESSAGE_DEDUPE_PREFIX = "queue:";

export interface QueuedMessageAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
}

/** Public row shape. The sender and lane stay server-side. */
export interface QueuedMessage {
  id: string;
  session_id: string;
  body_md: string;
  attachments: QueuedMessageAttachment[];
  client_id: string;
  status: QueuedMessageStatus;
  /** Send error of a `failed` row; null otherwise. */
  error: string | null;
  revision: number;
  released_message_id: string | null;
  released_via: QueuedMessageReleaseVia | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueuePause {
  reason: QueuePauseReason;
  at: string;
}

/** `GET /api/sessions/:sessionId/queue`: live rows in send order. */
export interface SessionQueue {
  items: QueuedMessage[];
  paused: QueuePause | null;
}

/** The ordinary log message a released row became. */
export interface QueuedMessageRelease<M = UnifiedMessage> {
  message: M;
  turn_id?: string;
}

export interface EnqueueQueuedMessageRequest {
  body_md: string;
  attachment_ids?: string[];
  client_id: string;
}

export interface UpdateQueuedMessageRequest {
  body_md: string;
  attachment_ids?: string[];
  expected_revision?: number;
}

export interface EnqueueQueuedMessageResponse<M = UnifiedMessage> {
  item: QueuedMessage;
  released: QueuedMessageRelease<M> | null;
}

export interface QueuedMessageItemResponse {
  item: QueuedMessage;
}

export interface SteerQueuedMessageResponse<M = UnifiedMessage> extends QueuedMessageRelease<M> {
  item: QueuedMessage;
}

export interface ResumeQueueResponse<M = UnifiedMessage> extends SessionQueue {
  released: QueuedMessageRelease<M>[];
}

export const QUEUED_MESSAGE_ERROR_CODES = [
  "invalid_queue_input",
  "queue_full",
  "not_a_chat",
  "chat_archived",
  "queue_actor_required",
  "not_queued_message_sender",
  "queued_message_not_found",
  "queued_message_deleted",
  "queued_message_consumed",
  "revision_conflict",
  "queued_message_send_failed",
] as const;
export type QueuedMessageErrorCode = typeof QUEUED_MESSAGE_ERROR_CODES[number];
