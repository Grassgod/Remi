/**
 * The Live Hub seam (MUL-403 §1, ADR 0007) — contracts and an empty
 * implementation. C0 ships no behaviour: C1 fills the ring buffer and fan-out in,
 * C2 exposes the trace subscription A-6 depends on, C3 wires the browser socket.
 *
 * `LiveHub` is one object satisfying three contracts at once:
 *
 * 1. **MUL-401 A-0's `TraceSink`** — `append(taskId, events)`, `head(taskId)` and
 *    `subscribe(taskId, fromSeq, onEvents)`, taken from MUL-401
 *    `cmt_mnbkcr3udd64` (A-0 itself is not on this branch yet; see
 *    `./upstream-contracts.ts`).
 * 2. **MUL-402 B1's `ConversationLogListener.onEntry(session_id, entry | patch)`**
 *    from `cmt_4dntxwh8ub1m`, with B0's row shape.
 * 3. **The stream-key subscription** the browser socket (C3) and A-6 (C2) use:
 *    `subscribe("log:<session_id>" | "trace:<task_id>", fromSeq, onFrames)`.
 *
 * Two `subscribe` spellings, two result shapes
 * --------------------------------------------
 * Keys are the hub's own address space, so a keyed subscription reports the
 * missing range (`gap: {from, to}`) and the replica's freshness token
 * (`log_version`). A-0's `TraceSink` subscription, addressed by a bare task id,
 * reports `gap: boolean`. They are deliberately distinct — A-0 is published and
 * may not be widened — and TypeScript picks between them by the *listener* type,
 * because a `HubFrameListener` is not assignable to `A0TraceSinkListener` or the
 * other way round. The four call combinations are pinned in
 * `tests/unit/multiremi/live-hub-contract.test.ts`.
 */

import { parseHubStreamKey } from "@multiremi/contracts/live-hub.js";
import type {
  HubFrame,
  HubFrameListener,
  HubSubscription,
  HubSeqRange,
  HubStreamKey,
} from "@multiremi/contracts/live-hub.js";
import type { HubTransport } from "./hub-transport.js";
import type {
  A0TraceEvent,
  A0TraceSink,
  A0TraceSinkAppendResult,
  A0TraceSinkListener,
  A0TraceSinkSubscription,
  B0ConversationLogEntry,
} from "./upstream-contracts.js";

/**
 * The in-place update B1 emits after `revision++` (plan 2/6 §1): a hidden marker
 * or an edited row replaces part of an existing frame, and the frame keeps the
 * patched row's own `seq`.
 *
 * B0 published no patch type, and `cmt_4dntxwh8ub1m` fixes only the hook shape
 * `onEntry(session_id, entry | patch)`, so this is C0's reading of the plan.
 * 「B0/B1 推送后对齐」: when MUL-426 lands its writer, take its patch type here.
 */
export interface ConversationLogPatch {
  session_id: string;
  /** The `seq` of the row being patched — also the emitted frame's `seq`. */
  target_seq: number;
  /** The row's `revision` after this update. */
  revision: number;
  /** Only the fields that changed. */
  fields: {
    kind?: string;
    visibility?: "shown" | "hidden";
    body_md?: string;
    body_html?: string | null;
    render_version?: string | null;
    metadata?: Record<string, unknown>;
  };
}

/**
 * B1's write hook (MUL-402 MUL-426). Called after every insert *and* every
 * in-place update, so the hub can fan both out on the same `seq` axis the read
 * routes page over.
 */
export interface ConversationLogListener {
  onEntry(session_id: string, entry: B0ConversationLogEntry | ConversationLogPatch): void;
}

// ─── MUL-400 E5: human-request lifecycle ────────────────────────────────────────────────────────

/**
 * Human-request lifecycle events for MUL-400 E5's card pipeline
 * (`cmt_aq2g6g9vobev`), keyed by request id.
 *
 * `reminder_due` is deliberately **not** part of this feed: the bot host still
 * derives it from `expires_at` on its own timer, so it never travels through the
 * hub (plan 2/6 §3).
 */
export const HUMAN_REQUEST_EVENT_TYPES = [
  "created",
  "responded",
  "expired",
  "cancelled",
] as const;

export type HumanRequestEventType = (typeof HUMAN_REQUEST_EVENT_TYPES)[number];

export interface HumanRequestEvent {
  type: HumanRequestEventType;
  workspace_id: string;
  request_id: string;
  task_id: string;
  /** ISO timestamp of the transition, as the store recorded it. */
  at: string;
}

export type HumanRequestListener = (event: HumanRequestEvent) => void;

// ─── The hub ────────────────────────────────────────────────────────────────────────────────────

/**
 * The surface C1 implements.
 *
 * The keyed overload is declared first, so a stream key plus a frame listener
 * resolves to `HubSubscription`; a bare task id plus an A-0 listener resolves to
 * `A0TraceSinkSubscription`. Order matters for the first case only, and the test
 * pins it so it cannot drift unnoticed.
 */
export interface LiveHub extends A0TraceSink, ConversationLogListener {
  /** Subscribe by stream key. `fromSeq` is exclusive; see `HubSubscription`. */
  subscribe(key: HubStreamKey, fromSeq: number, onFrames: HubFrameListener): HubSubscription;
  /** A-0's spelling: the same trace stream addressed by a bare task id. */
  subscribe(taskId: string, fromSeq: number, onEvents: A0TraceSinkListener): A0TraceSinkSubscription;

  /**
   * Human-request fan-out for MUL-400 E5 (process-local, no replay, no seq).
   *
   * Returns the handle directly — unlike a stream subscription there is no
   * cursor to hand back, so there is nothing else to report.
   */
  subscribeHumanRequests(workspaceId: string, onEvent: HumanRequestListener): { unsubscribe(): void };

  /** Frames published for other processes go through here; `local` today. */
  readonly transport: HubTransport;
}

/**
 * C0's empty implementation: structurally complete, stateless, side-effect free.
 *
 * It is the proof that the seam can be referenced by the server without changing
 * behaviour — nothing on the request path imports it, and every call answers with
 * the honest "I hold nothing" value instead of a fabricated head:
 *
 * - `head` → `null` (A-0's answer for a task the sink has never seen);
 * - `append` → `{head: 0}`, i.e. no sequence was allocated;
 * - `subscribe*` → `first_seq: 1, head: 0` with an inert handle and no frames;
 * - `onEntry` / `subscribeHumanRequests` → no-op.
 *
 * C1 replaces every body. The signatures above are frozen here so C1/C2/C3 can be
 * written against them.
 */
export class EmptyLiveHub implements LiveHub {
  constructor(readonly transport: HubTransport) {}

  append(_taskId: string, _events: A0TraceEvent[]): A0TraceSinkAppendResult {
    // No ring and no sequence allocation: the head of an empty sink is 0, never a
    // number this class invented.
    return { head: 0 };
  }

  head(_taskId: string): number | null {
    return null;
  }

  subscribe(key: HubStreamKey, fromSeq: number, onFrames: HubFrameListener): HubSubscription;
  subscribe(taskId: string, fromSeq: number, onEvents: A0TraceSinkListener): A0TraceSinkSubscription;
  subscribe(
    keyOrTaskId: string,
    fromSeq: number,
    _onEvents: HubFrameListener | A0TraceSinkListener,
  ): HubSubscription | A0TraceSinkSubscription {
    // An empty ring can serve nothing from `from_seq`, so the range is
    // `[1, 0]` — head 0 is what C1's warm-up will overwrite once the read pool
    // lands — and neither spelling reports a gap, because there is no retained
    // tail to fall behind. `log_version: null` means "unknown", which is exactly
    // what an empty hub knows.
    //
    // The prefix test goes through the contract's parser rather than a local
    // `startsWith`, so the key grammar has exactly one definition.
    if (parseHubStreamKey(keyOrTaskId)) {
      return { first_seq: 1, head: 0, log_version: null, gap: null, unsubscribe: () => {} };
    }
    return { first_seq: 1, head: 0, gap: false, unsubscribe: () => {} };
  }

  onEntry(_sessionId: string, _entry: B0ConversationLogEntry | ConversationLogPatch): void {
    // C1: enqueue into the `log:<session_id>` ring and schedule the fan-out.
  }

  subscribeHumanRequests(_workspaceId: string, _onEvent: HumanRequestListener): { unsubscribe(): void } {
    return { unsubscribe: () => {} };
  }
}

/**
 * The upstream commits the two hand-written seams in `./upstream-contracts.ts`
 * must be replaced by, and the reason they are stand-ins at all.
 *
 * C0's branch base predates both A-0 and B0, and C0 may not merge either branch,
 * so the shapes are transcribed and cross-checked against the pushed commits
 * instead of imported. Exported (rather than only commented) so the contract test
 * can assert the alignment promise still names a real commit and cannot be
 * quietly deleted while the imports stay hand-written.
 */
export const EMPTY_LIVE_HUB_ALIGNMENT_NOTES = [
  "A-0 (MUL-401, commit 5fa2a3e2, PR #261): replace upstream-contracts.ts A0TraceEvent/A0TraceSink* with @multiremi/api/trace/trace-sink.js and @multiremi/contracts/trace.js.",
  "B0 (MUL-425, commit fe7810c9, PR #262): replace upstream-contracts.ts B0ConversationLogEntry with @multiremi/contracts/conversation-log.js, and take MUL-426's patch type for ConversationLogPatch.",
] as const;

/** Build the empty hub with a caller-supplied transport. */
export function createEmptyLiveHub(transport: HubTransport): LiveHub {
  return new EmptyLiveHub(transport);
}

/** Re-exported so a caller can name a hub shape without reaching into contracts. */
export type { HubFrame, HubFrameListener, HubSubscription, HubSeqRange, HubStreamKey };
export type {
  A0TraceEvent,
  A0TraceSink,
  A0TraceSinkListener,
  A0TraceSinkSubscription,
  B0ConversationLogEntry,
};
