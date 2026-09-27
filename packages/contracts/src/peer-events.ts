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
 * `payload` is the raw event as the store produced it (the `MultiremiTask`
 * object, the messages array, the workspace-event envelope). Ordering is the
 * sender's job — batches go out one at a time on a single serial chain — so
 * nothing here carries a sequence number. There is no persistence or replay:
 * browsers refetch on reconnect and daemons keep polling.
 */

import type {
  MultiremiTask,
  MultiremiTaskMessage,
} from "./types.js";

export const PEER_EVENT_PROTOCOL_VERSION = 1 as const;

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

export interface PeerTaskEnqueuedPayload {
  task: MultiremiTask;
}

export interface PeerTaskEventPayload {
  type: string;
  task: MultiremiTask;
}

export interface PeerTaskMessagesPayload {
  task: MultiremiTask;
  messages: MultiremiTaskMessage[];
}

export interface PeerWorkspaceEventPayload {
  event: PeerWorkspaceEvent;
}

/** Payload carried by an envelope, discriminated by the envelope's `kind`. */
export type PeerEventPayload = {
  task_enqueued: PeerTaskEnqueuedPayload;
  task_event: PeerTaskEventPayload;
  task_messages: PeerTaskMessagesPayload;
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
  sent?: number;
  batches?: number;
  dropped?: number;
  failed?: number;
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
  return record as unknown as PeerEventEnvelope;
}

/**
 * Narrow an unknown JSON body to a batch, or null when it is not one.
 *
 * Shape only: `topic` plus an `events` array. Individual envelopes are the
 * receiver's business (see `PeerEventBatch.events`), and a body with no topic
 * is rejected rather than guessed at, so a caller cannot silently post a stream
 * nobody subscribed to.
 */
export function parsePeerEventBatch(value: unknown): PeerEventBatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) return null;
  if (typeof record.topic !== "string" || !record.topic.trim()) return null;
  return { topic: record.topic.trim(), events: record.events };
}
