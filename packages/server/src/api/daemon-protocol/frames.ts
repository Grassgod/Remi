/**
 * Wire decoding for daemon protocol v2 (MUL-417).
 *
 * A-0 owns the frame *vocabulary* (`packages/contracts/src/daemon-protocol.ts`:
 * frame names, categories, limits, close codes). This file owns the bytes:
 * turning one decoded text frame into a shape the connection layer can dispatch
 * on without trusting it, and turning our own frames back into JSON.
 *
 * Nothing here validates that `t` is a known frame type. That decision belongs to
 * the dispatcher, which answers an unknown type with `res{ok:false,
 * code:"unknown_frame"}` rather than refusing to parse the frame at all - a peer
 * that adds a frame type must get a diagnosable answer, not a dead socket.
 */

import { DAEMON_PROTOCOL_VERSION } from "@multiremi/contracts/daemon-protocol.js";

/** The parse result, with every optional field already narrowed to its type. */
export interface DaemonParsedFrame {
  /** Raw frame type. Non-empty, but only the dispatcher knows if it is defined. */
  type: string;
  /** Protocol version as advertised by the sender, or null when absent/unreadable. */
  v: number | null;
  /** Reliable-frame sequence, or null. */
  seq: number | null;
  /** Cumulative acknowledgement, either standalone or piggybacked, or null. */
  ack: number | null;
  /** RPC request id, or null. */
  id: string | null;
  /** The `id` this frame answers, or null. */
  re: string | null;
  /** Runtime scope, or null for process-scoped frames. */
  rt: string | null;
  /** Sender wall clock in ms, or null. */
  ts: number | null;
  /** Payload. Always an object, so handlers never branch on `p` being absent. */
  payload: Record<string, unknown>;
  /** The whole decoded object, for handlers that need a field we did not lift. */
  raw: Record<string, unknown>;
}

export type DaemonFrameParseFailure =
  | "invalid_json"
  | "not_an_object"
  | "missing_type";

export type DaemonFrameParseResult =
  | { ok: true; frame: DaemonParsedFrame }
  | { ok: false; reason: DaemonFrameParseFailure };

/** Decode one inbound text frame. Never throws: a hostile frame is a value, not an exception. */
export function parseDaemonProtocolFrame(text: string): DaemonFrameParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, reason: "not_an_object" };
  }
  const raw = decoded as Record<string, unknown>;
  const type = typeof raw.t === "string" ? raw.t.trim() : "";
  if (!type) return { ok: false, reason: "missing_type" };
  return {
    ok: true,
    frame: {
      type,
      v: readInteger(raw.v),
      seq: readInteger(raw.seq),
      ack: readInteger(raw.ack),
      id: readString(raw.id),
      re: readString(raw.re),
      rt: readString(raw.rt),
      ts: readInteger(raw.ts),
      payload: readPayload(raw.p),
      raw,
    },
  };
}

/** One outbound frame. `ts` defaults to now; `v` is always the pinned version. */
export interface DaemonOutboundFrame {
  t: string;
  seq?: number;
  ack?: number;
  id?: string;
  re?: string;
  rt?: string;
  ts?: number;
  p?: unknown;
}

export function encodeDaemonProtocolFrame(frame: DaemonOutboundFrame, now = Date.now()): string {
  const wire: Record<string, unknown> = { v: DAEMON_PROTOCOL_VERSION, t: frame.t, ts: frame.ts ?? now };
  if (frame.seq !== undefined) wire.seq = frame.seq;
  if (frame.ack !== undefined) wire.ack = frame.ack;
  if (frame.id !== undefined) wire.id = frame.id;
  if (frame.re !== undefined) wire.re = frame.re;
  if (frame.rt !== undefined) wire.rt = frame.rt;
  if (frame.p !== undefined) wire.p = frame.p;
  return JSON.stringify(wire);
}

/**
 * Encoded size of an inbound message, in bytes.
 *
 * A `BufferSource` is measured without copying, and a string through
 * `Buffer.byteLength` rather than `TextEncoder`, because this runs on every
 * frame and the limit is the only thing it is used for.
 */
export function daemonFrameBytes(message: string | ArrayBuffer | Uint8Array): number {
  if (typeof message === "string") return Buffer.byteLength(message, "utf8");
  if (message instanceof ArrayBuffer) return message.byteLength;
  return message.byteLength;
}

/** Decode either inbound message shape to text. */
export function daemonFrameText(message: string | ArrayBuffer | Uint8Array): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(message));
  return new TextDecoder().decode(message);
}

/** Read an integer field, treating anything else (including `1.5`, `"1"`, NaN) as absent. */
export function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Read a non-empty trimmed string field. */
export function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Read the payload object, substituting `{}` for a missing or non-object payload. */
export function readPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
