/**
 * The tab-to-tab channel (MUL-403 C7 §3).
 *
 * One leader tab owns the Worker, the database and the subscription; every other
 * tab asks it for what it needs over a `BroadcastChannel`. Two message kinds are
 * load-bearing:
 *
 * - `replica:open` / `replica:close` — a tab announces a session it is showing,
 *   and the leader refcounts them so it subscribes exactly the sessions that at
 *   least one tab is watching (the acceptance criterion "只有 1 页在订阅");
 * - `replica:appended` / `replica:cleared` — the leader pushes out what changed,
 *   so a reader tab re-reads its window instead of polling.
 *
 * The channel carries no rows. A reader that learns "seqs 40..60 landed" reads
 * them from the leader with `replica:query`, which keeps the one-write-path
 * invariant: only the leader's Worker ever touches SQLite.
 */

import type { HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { SessionLogEntry } from "./port";

/** Namespace only; shared channels must use `replicaLockName(userId, workspaceId)`. */
export const REPLICA_CHANNEL = "remi-replica";

/** `navigator.locks` name. The plan's spelling, kept verbatim: `remi-replica:<user>:<ws>`. */
export const REPLICA_LOCK_PREFIX = "remi-replica:";

export function replicaLockName(userId: string, workspaceId: string): string {
  return `${REPLICA_LOCK_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

/** A read request from a non-leader tab; the leader answers with `replica:window`. */
export interface ReplicaQueryMessage {
  type: "replica:query";
  /** Correlates the answer; the leader echoes it. */
  requestId: string;
  sessionId: string;
  from: number;
  to: number;
}

export interface ReplicaQueryResultMessage {
  type: "replica:window";
  requestId: string;
  sessionId: string;
  entries: SessionLogEntry[];
  snapshot: {
    head: number | null;
    fresh: boolean;
    ready: boolean;
  };
}

/**
 * A measurement a follower took, on its way to the leader's database.
 *
 * The height cache is written by whichever tab measured the row (plan 3/6 §3), but
 * only the leader's Worker may touch storage — so a follower's measurement travels
 * here rather than being kept locally, which would make the cache useless to the
 * tab that renders next.
 */
export interface ReplicaRowHeightMessage {
  type: "replica:rowHeight";
  sessionId: string;
  seq: number;
  key: string;
  height: number;
}

/** A tab starts (or stops) watching a session, so the leader knows what to hold. */
export interface ReplicaOpenMessage {
  type: "replica:open" | "replica:close";
  sessionId: string;
}

/** The leader appended rows; readers re-read the range they care about. */
export interface ReplicaAppendedMessage {
  type: "replica:appended";
  sessionId: string;
  range: HubSeqRange;
  head: number | null;
  fresh: boolean;
}

/** The whole database was dropped (logout, user mismatch, schema upgrade). */
export interface ReplicaClearedMessage {
  type: "replica:cleared";
  reason: "logout" | "user_mismatch" | "schema_upgrade";
}

/**
 * The leader changed hands.
 *
 * A new leader must re-subscribe every session that is still open, so the
 * announcement carries the count it inherited; a reader tab re-announces its own
 * interest on seeing this, which is what makes the handoff complete without the
 * new leader having observed the old one's refcounts.
 */
export interface ReplicaLeaderChangedMessage {
  type: "replica:leader";
  /** The lock holder's tab id. */
  tabId: string;
  /** Sessions the previous leader was holding, if it could say. */
  sessions: string[];
}

export interface ReplicaAckMessage {
  type: "replica:ack";
  sessionId: string;
  ack: HubStreamAckPayload;
}

export type ReplicaChannelMessage = (
  | ReplicaQueryMessage
  | ReplicaQueryResultMessage
  | ReplicaOpenMessage
  | ReplicaAppendedMessage
  | ReplicaClearedMessage
  | ReplicaLeaderChangedMessage
  | ReplicaAckMessage
  | ReplicaRowHeightMessage
) & { identityKey?: string; senderTabId?: string };
