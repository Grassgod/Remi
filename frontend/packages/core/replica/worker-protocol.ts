/**
 * The page ⇄ Worker messages (MUL-403 C7 §2, §7).
 *
 * The split follows the plan's constraint literally: "流数据的处理放在 worker 里，
 * 不依赖页面定时器，因为后台标签页的定时器会被节流". So the page owns the socket
 * (the token lives in `localStorage`, which a worker cannot read) and forwards the
 * frames it receives unchanged; deciding what they mean — inserting, patching,
 * coverage, the gap to backfill — happens inside the Worker, on the storage's
 * thread, with no timer of its own.
 *
 * Nothing here is a second protocol: the bodies are the same six steps, sent as
 * messages instead of calls.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { SessionLogEntry } from "./port";

/** How the Worker opens its database. `opfs` is the plan's VFS; `memory` is the degrade path. */
export type ReplicaWorkerStorage = "opfs" | "memory";

export interface ReplicaWorkerInitMessage {
  type: "init";
  userId: string;
  workspaceId: string;
  storage: ReplicaWorkerStorage;
}

export interface ReplicaWorkerOpenMessage {
  type: "open";
  sessionId: string;
}

export interface ReplicaWorkerAckMessage {
  type: "ack";
  sessionId: string;
  ack: HubStreamAckPayload;
}

export interface ReplicaWorkerFramesMessage {
  type: "frames";
  sessionId: string;
  frames: readonly HubFrame[];
}

export interface ReplicaWorkerWindowMessage {
  type: "window";
  sessionId: string;
  from: number;
  to: number;
}

/** Store a window fetched through the read route (gap or deep link). */
export interface ReplicaWorkerWriteWindowMessage {
  type: "writeWindow";
  sessionId: string;
  entries: readonly SessionLogEntry[];
  range: HubSeqRange;
}

export interface ReplicaWorkerReadHeightMessage {
  type: "readHeight";
  sessionId: string;
  seq: number;
  key: string;
}

export interface ReplicaWorkerWriteHeightMessage {
  type: "writeHeight";
  sessionId: string;
  seq: number;
  key: string;
  height: number;
}

export interface ReplicaWorkerClearMessage {
  type: "clear";
  reason: "logout" | "user_mismatch" | "schema_upgrade";
}

export interface ReplicaWorkerSnapshotMessage {
  type: "snapshot";
  sessionId: string;
}

export type ReplicaWorkerRequest = (
  | ReplicaWorkerInitMessage
  | ReplicaWorkerOpenMessage
  | ReplicaWorkerAckMessage
  | ReplicaWorkerFramesMessage
  | ReplicaWorkerWindowMessage
  | ReplicaWorkerWriteWindowMessage
  | ReplicaWorkerReadHeightMessage
  | ReplicaWorkerWriteHeightMessage
  | ReplicaWorkerClearMessage
  | ReplicaWorkerSnapshotMessage
) & { token?: string; epoch?: number };

export interface ReplicaWorkerReadyMessage {
  type: "ready";
  /** Which storage actually opened; `memory` when OPFS was unavailable. */
  storage: ReplicaWorkerStorage;
  /** The degrade reason, when `storage` is `memory` despite asking for `opfs`. */
  degraded: string | null;
}

export interface ReplicaWorkerOpenedMessage {
  type: "opened";
  sessionId: string;
  fromSeq: number;
  head: number | null;
  fresh: boolean;
  /** Set when `open` had to wipe the database (user mismatch / schema upgrade). */
  cleared: "logout" | "user_mismatch" | "schema_upgrade" | null;
  /** The window the database already held — what a takeover paints before replay. */
  entries: SessionLogEntry[];
}

export interface ReplicaWorkerBackfillMessage {
  type: "backfill";
  sessionId: string;
  range: HubSeqRange | null;
  reset: boolean;
  head: number | null;
  fresh: boolean;
  ready: boolean;
  entries: SessionLogEntry[];
}

export interface ReplicaWorkerAppendedMessage {
  type: "appended";
  sessionId: string;
  /** Range the batch wrote, for the `replica:appended` broadcast. */
  range: HubSeqRange | null;
  head: number | null;
  fresh: boolean;
  /** The hole the batch exposed; the leader backfills it before anything else. */
  missing: HubSeqRange | null;
  /**
   * The window the replica now holds.
   *
   * Carried with the answer rather than requiring a follow-up `window` request,
   * because the page's port is synchronous: the list reads `getSnapshot` on the
   * next render, and a second round trip would show the stale window for a frame.
   * The plan describes the same shape (`{entries, head_seq, fresh}` after a write).
   */
  entries: SessionLogEntry[];
}

export interface ReplicaWorkerWindowResultMessage {
  type: "windowResult";
  sessionId: string;
  entries: SessionLogEntry[];
  head: number | null;
  fresh: boolean;
  ready: boolean;
}

export interface ReplicaWorkerHeightMessage {
  type: "height";
  sessionId: string;
  seq: number;
  key: string;
  height: number | null;
}

export interface ReplicaWorkerClearedMessage {
  type: "cleared";
  reason: "logout" | "user_mismatch" | "schema_upgrade";
}

export interface ReplicaWorkerErrorMessage {
  type: "error";
  /** The request that failed, for the caller's log. */
  request: ReplicaWorkerRequest["type"] | null;
  message: string;
}

export type ReplicaWorkerResponse = (
  | ReplicaWorkerReadyMessage
  | ReplicaWorkerOpenedMessage
  | ReplicaWorkerBackfillMessage
  | ReplicaWorkerAppendedMessage
  | ReplicaWorkerWindowResultMessage
  | ReplicaWorkerHeightMessage
  | ReplicaWorkerClearedMessage
  | ReplicaWorkerErrorMessage
) & { token?: string; epoch?: number };
