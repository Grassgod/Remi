/**
 * Wire contract for the cross-process realtime peer channel (MUL-462, MUL-455 §1.4).
 *
 * When the API is split into a browser-facing process and a daemon-facing one,
 * the store's in-process listeners only see the writes of their own runtime.
 * The peer channel carries those events to the other side over a loopback HTTP
 * POST; the receiver only delivers them locally and never forwards them
 * again, so the two sides cannot ping-pong an event forever.
 *
 * The envelope is deliberately small and versioned: `v` is the only field a
 * receiver may branch on before it trusts the rest, and `origin` exists so a
 * process can drop a message it somehow receives back from itself.
 *
 * Task messages carry a six-field routing subject or a persisted seq reference;
 * other event kinds retain their store shape. Ordered, numbered batches retry
 * identical bytes and receivers deduplicate within their process lifetime.
 */

import type {
  MultiremiTask,
  MultiremiTaskMessage,
} from "./types.js";
import type { TaskMessageFanoutSubject } from "@multiremi/store/context.js";

export const PEER_EVENT_PROTOCOL_VERSION = 1 as const;

/**
 * Largest single event envelope the peer channel will carry, in bytes.
 *
 * The batch body has to fit one POST, and the receiving process has to parse it
 * without stalling its event loop, so a single event may never approach that
 * size. Callers that can split or degrade do so before publishing; the channel
 * drops and counts anything still over the line.
 */
export const PEER_MAX_EVENT_BYTES = 1_048_576 as const;

export const PEER_EVENT_KINDS = [
  "task_enqueued",
  "task_event",
  "task_messages",
  "workspace_event",
] as const;

export type PeerEventKind = (typeof PEER_EVENT_KINDS)[number];

/**
 * One workspace/realtime event.
 *
 * Structurally identical to the store's `WorkspaceEventListener` argument, which
 * cannot be imported here without making `contracts` depend on `server`.
 */
export interface PeerWorkspaceEvent {
  type: string;
  workspaceId: string;
  chatSessionId?: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string | null;
}

/**
 * A task reference used when the full task would not fit one event (MUL-462).
 *
 * `MultiremiTask.prompt` is capped at 2 MiB, so a queued task can exceed the
 * 1 MiB event budget without any client misbehaving. The receiver shares the
 * database with the sender, so it rebuilds the frame from `task_id` and gets the
 * same row. Task-message references instead read a narrow subject and a seq range.
 */
export interface PeerTaskReference {
  task_id: string;
  /** True when the sender dropped the task body and the receiver must re-read it. */
  degraded: true;
}

export interface PeerTaskEnqueuedPayload {
  /** Absent on a degraded event; use `task_id` then. */
  task?: MultiremiTask;
  task_id: string;
  degraded?: true;
}

export interface PeerTaskEventPayload {
  type: string;
  /** Absent on a degraded event; use `task_id` then. */
  task?: MultiremiTask;
  task_id: string;
  degraded?: true;
}

export interface PeerTaskMessagesPayload {
  task?: TaskMessageFanoutSubject;
  task_id: string;
  degraded?: true;
  /** One message per event: the sender splits a batch of appends before queueing. */
  messages: MultiremiTaskMessage[];
}

/** Inclusive persisted message range; no task body or message content crosses the wire. */
export interface PeerTaskMessagesReferencePayload {
  task_id: string;
  degraded: true;
  seq_start: number;
  seq_end: number;
}

export interface PeerWorkspaceEventPayload {
  event: PeerWorkspaceEvent;
}

/** Payload carried by an envelope, discriminated by the envelope's `kind`. */
export type PeerEventPayload = {
  task_enqueued: PeerTaskEnqueuedPayload;
  task_event: PeerTaskEventPayload;
  task_messages: PeerTaskMessagesPayload | PeerTaskMessagesReferencePayload;
  workspace_event: PeerWorkspaceEventPayload;
};

export interface PeerEventEnvelopeOf<K extends PeerEventKind = PeerEventKind> {
  /** Protocol version. Receivers reject anything they do not understand. */
  v: typeof PEER_EVENT_PROTOCOL_VERSION;
  /** Process that produced the event; a receiver drops its own origin back. */
  origin: string;
  kind: K;
  payload: PeerEventPayload[K];
}

/**
 * One envelope, as a discriminated union.
 *
 * The union matters at the receiving end: after switching on `kind`, TypeScript
 * narrows `payload` to the matching shape, so a delivery path cannot read
 * `payload.event` off a `task_messages` envelope.
 */
export type PeerEventEnvelope = {
  [K in PeerEventKind]: PeerEventEnvelopeOf<K>;
}[PeerEventKind];

/**
 * The body of `POST /internal/peer/events`: one flush, in order.
 *
 * `topic` names the stream the frames belong to. `realtime` is the four store
 * events; MUL-403 adds `hub` for Live Hub frames. A batch never mixes topics,
 * which is what lets the receiver dispatch without inspecting each frame.
 */
export interface PeerEventBatch {
  topic: string;
  /**
   * Sender identity for this process lifetime. A receiver keeps one high-water
   * mark per epoch, so a retry that the sender never saw the response for is
   * recognized instead of delivered twice.
   */
  epoch: string;
  /**
   * Monotonic per-epoch batch number. A batch keeps its number across retries,
   * and the sender only ever has one batch in flight, so "at or below the high
   * water mark" is exactly "already handled".
   */
  batch_seq: number;
  /**
   * Envelopes are validated one at a time by the receiver, not here: rejecting
   * the whole body over one bad frame would make the sender retry that batch
   * forever and wedge its queue behind it.
   */
  events: unknown[];
}

/** `POST /internal/peer/events` response: how much of the batch was taken. */
export interface PeerEventAck {
  ok: true;
  accepted: number;
  /** Envelopes refused: malformed, wrong version, or this process's own origin. */
  rejected: number;
  /**
   * The batch was already handled under this epoch and `batch_seq`, so nothing
   * was delivered again. The sender treats it exactly like a fresh success.
   */
  duplicate?: true;
}

/**
 * `GET /internal/peer/health` response.
 *
 * The counter fields are absent when this process has no peer configured — an
 * unconfigured channel has nothing to report rather than zeroes, so a runbook
 * can tell "off" from "idle".
 */
export interface PeerHealth {
  ok: true;
  /** Whether this process has a peer URL configured at all. */
  enabled: boolean;
  /** False when the channel is disabled, or the last flush failed. */
  peer_healthy: boolean;
  origin?: string;
  queued?: number;
  /** Events accepted from the peer and delivered locally. */
  received?: number;
  /** Inbound envelopes refused (malformed, or our own origin echoed back). */
  rejected?: number;
  /** Batches recognized as retries and answered without re-delivering. */
  duplicates?: number;
  /** Inbound events the sender had to slim down to a task reference. */
  degraded?: number;
  sent?: number;
  batches?: number;
  /**
   * Events that never left this process: backlog evicted to stay inside the queue
   * caps, plus whatever is still queued or frozen in the retry slot at close.
   * Disjoint from `oversize_dropped`.
   */
  dropped?: number;
  /**
   * Events discarded because one event alone exceeded the 1 MiB budget. Disjoint
   * from `dropped`, which counts backlog evictions instead.
   */
  oversize_dropped?: number;
  failed?: number;
  /** Bytes currently held by the send queue. Excludes `inflight_bytes`. */
  queued_bytes?: number;
  /** Events in the active/frozen slot (0, or the size of one batch). */
  inflight?: number;
  /** Actual POST body bytes held by the active/frozen slot. */
  inflight_bytes?: number;
  rtt_p95_ms?: number;
}

/** Narrow an unknown JSON value to an envelope, or null when it is not one. */
export function parsePeerEventEnvelope(value: unknown): PeerEventEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== PEER_EVENT_PROTOCOL_VERSION) return null;
  if (typeof record.origin !== "string" || !record.origin) return null;
  if (typeof record.kind !== "string" || !PEER_EVENT_KINDS.includes(record.kind as PeerEventKind)) {
    return null;
  }
  if (typeof record.payload !== "object" || record.payload === null) return null;
  const payload = record.payload as Record<string, unknown>;
  if (record.kind === "task_messages" && ("seq_start" in payload || "seq_end" in payload)) {
    if (typeof payload.task_id !== "string" || !payload.task_id || payload.degraded !== true
      || !Number.isSafeInteger(payload.seq_start) || !Number.isSafeInteger(payload.seq_end)
      || (payload.seq_start as number) < 1 || (payload.seq_end as number) < (payload.seq_start as number)
      || "task" in payload || "messages" in payload) return null;
  }
  return record as unknown as PeerEventEnvelope;
}

/**
 * Narrow an unknown JSON body to a batch, or null when it is not one.
 *
 * Shape only: `topic`, the dedupe pair (`epoch`, `batch_seq`), and an `events`
 * array. Individual envelopes are the receiver's business (see
 * `PeerEventBatch.events`), and a body missing its topic or its dedupe pair is
 * rejected rather than guessed at: without them the receiver could neither
 * route nor deduplicate.
 */
export function parsePeerEventBatch(value: unknown): PeerEventBatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) return null;
  if (typeof record.topic !== "string" || !record.topic.trim()) return null;
  if (typeof record.epoch !== "string" || !record.epoch.trim()) return null;
  if (!Number.isInteger(record.batch_seq) || (record.batch_seq as number) < 1) return null;
  return {
    topic: record.topic.trim(),
    epoch: record.epoch.trim(),
    batch_seq: record.batch_seq as number,
    events: record.events,
  };
}
