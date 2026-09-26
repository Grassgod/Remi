/**
 * Live Hub contracts (MUL-403, message architecture v2-C; ADR 0007).
 *
 * One in-process hub is the single fan-out point for two ordered streams:
 *
 * - `log:<session_id>`  — MUL-402's conversation-log display units and hidden
 *   markers, ordered by the row's own `seq`.
 * - `trace:<task_id>`   — MUL-401's trace events, ordered by the daemon-assigned
 *   `trace_seq`. The hub never renumbers: its cursor and MUL-402's file offsets
 *   both speak the daemon's numbering.
 *
 * Type and constant module only: no I/O, no timers, no runtime dependency on the
 * server. The implementation skeleton lives in
 * `packages/server/src/api/hub/` and is empty in C0; C1 fills it in.
 *
 * Deliberately absent from the root barrel (`src/index.ts`): this module ships
 * runtime values, and a barrel value-import is what broke `next build` twice
 * (MUL-108, MUL-314). Consumers import the `@multiremi/contracts/live-hub`
 * subpath instead.
 */

// ─── Stream keys ────────────────────────────────────────────────────────────────────────────────

/** Prefix of a conversation-log stream key: `log:<session_id>`. */
export const HUB_LOG_STREAM_PREFIX = "log:" as const;

/** Prefix of a trace stream key: `trace:<task_id>`. */
export const HUB_TRACE_STREAM_PREFIX = "trace:" as const;

export type HubLogStreamKey = `${typeof HUB_LOG_STREAM_PREFIX}${string}`;
export type HubTraceStreamKey = `${typeof HUB_TRACE_STREAM_PREFIX}${string}`;

/** Every key a subscription can name. */
export type HubStreamKey = HubLogStreamKey | HubTraceStreamKey;

/** Stream kind as it travels on the browser socket — the `stream` field of every v2 frame. */
export type HubStreamName = "log" | "trace";

export function hubLogStreamKey(sessionId: string): HubLogStreamKey {
  return `${HUB_LOG_STREAM_PREFIX}${sessionId}`;
}

export function hubTraceStreamKey(taskId: string): HubTraceStreamKey {
  return `${HUB_TRACE_STREAM_PREFIX}${taskId}`;
}

export interface ParsedHubStreamKey {
  stream: HubStreamName;
  id: string;
}

/**
 * Split a stream key into its kind and entity id.
 *
 * Returns null when the key carries no known prefix (or nothing after it), so a
 * caller that treats a bare id as an error is not silently handed a bogus
 * stream. Note that a bare task id is the shape A-0's `TraceSink.subscribe`
 * uses; that overload passes the id directly and never reaches this parser.
 */
export function parseHubStreamKey(key: string): ParsedHubStreamKey | null {
  if (key.startsWith(HUB_LOG_STREAM_PREFIX)) {
    const id = key.slice(HUB_LOG_STREAM_PREFIX.length);
    return id ? { stream: "log", id } : null;
  }
  if (key.startsWith(HUB_TRACE_STREAM_PREFIX)) {
    const id = key.slice(HUB_TRACE_STREAM_PREFIX.length);
    return id ? { stream: "trace", id } : null;
  }
  return null;
}

// ─── Frames ─────────────────────────────────────────────────────────────────────────────────────

/** The three payload shapes a stream can carry, discriminated by `kind`. */
export const HUB_FRAME_KINDS = ["entry", "patch", "trace"] as const;

export type HubFrameKind = (typeof HUB_FRAME_KINDS)[number];

/**
 * One ordered stream frame.
 *
 * `seq` is the upstream sequence, not a hub counter: the conversation-log row's
 * `seq` for `entry`/`patch`, the daemon's trace seq for `trace`. Payloads stay
 * opaque here because their owners have not landed yet (MUL-402 B0's
 * `ConversationLogEntry`/patch, MUL-401 A-0's `TraceEvent`); C1/C2/C3 fill the
 * mapping in. The hub serializes a frame once at enqueue time and shares the
 * string with every subscriber.
 */
export interface HubFrame {
  seq: number;
  kind: HubFrameKind;
  payload: unknown;
}

/** Delivery callback: one batch of frames for one stream key. */
export type HubFrameListener = (key: HubStreamKey, frames: readonly HubFrame[]) => void;

// ─── Subscriptions ──────────────────────────────────────────────────────────────────────────────

/** An inclusive sequence range the hub can no longer serve. */
export interface HubSeqRange {
  from: number;
  to: number;
}

/**
 * Result of subscribing to a stream key.
 *
 * `first_seq` is the oldest sequence the subscription can still serve and `head`
 * is the newest it knows; the range is `[first_seq, head]`. A `fromSeq` older
 * than `first_seq` comes back as `gap = {from: fromSeq, to: first_seq - 1}`, and
 * the caller backfills that range itself — the hub never reads the database to
 * fill a hole. `log_version` is only meaningful for `log:` streams and is the
 * replica's freshness token (equal `log_version` and equal `head` means fresh).
 */
export interface HubSubscription {
  first_seq: number;
  head: number;
  log_version?: number | null;
  gap?: HubSeqRange | null;
  unsubscribe(): void;
}

// ─── Browser WebSocket v2 frames (plan 2/6 §2) ──────────────────────────────────────────────────

/** `stream.subscribe`: start (or resume) one stream, from `from_seq` exclusive. */
export interface HubStreamSubscribePayload {
  stream: HubStreamName;
  id: string;
  /** The next sequence the client wants; resume after a reconnect sends local `head + 1`. */
  from_seq: number;
}

/** `stream.unsubscribe`: stop one stream. */
export interface HubStreamUnsubscribePayload {
  stream: HubStreamName;
  id: string;
}

/** `stream.ack`: the subscription is live. Answer to `stream.subscribe`. */
export interface HubStreamAckPayload {
  stream: HubStreamName;
  id: string;
  first_seq: number;
  head_seq: number;
  log_version?: number | null;
  gap?: HubSeqRange | null;
}

/** `stream.data`: one batch of frames, in `seq` order. */
export interface HubStreamDataPayload {
  stream: HubStreamName;
  id: string;
  frames: readonly HubFrame[];
}

/** `stream.gap`: the client fell behind; backfill `[from, to]` through the read routes. */
export interface HubStreamGapPayload {
  stream: HubStreamName;
  id: string;
  from: number;
  to: number;
}

/**
 * `stream.error`: the subscription failed. The code set is frozen by C3 together
 * with the handler that emits it; C0 deliberately does not invent one here.
 */
export interface HubStreamErrorPayload {
  stream: HubStreamName;
  id: string;
  code: string;
}

/**
 * Client → server. `auth` (v1) and `auth_ack` (server → client) stay exactly as
 * they are and are therefore not restated: C3 adds the frames below without
 * touching the handshake.
 */
export type BrowserWsClientFrame =
  | { type: "stream.subscribe"; payload: HubStreamSubscribePayload }
  | { type: "stream.unsubscribe"; payload: HubStreamUnsubscribePayload }
  | { type: "ping" };

/** Server → client. `pong` carries no payload, matching the current handler. */
export type BrowserWsServerFrame =
  | { type: "stream.ack"; payload: HubStreamAckPayload }
  | { type: "stream.data"; payload: HubStreamDataPayload }
  | { type: "stream.gap"; payload: HubStreamGapPayload }
  | { type: "stream.error"; payload: HubStreamErrorPayload }
  | { type: "pong" };

export type BrowserWsClientFrameType = BrowserWsClientFrame["type"];
export type BrowserWsServerFrameType = BrowserWsServerFrame["type"];
