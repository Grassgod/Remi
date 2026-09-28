/**
 * The Live Hub seam (MUL-403 §1, ADR 0007) — contracts and an empty
 * implementation. C0 ships no behaviour: C1 fills the ring buffer and fan-out in,
 * C2 exposes the trace subscription A-6 depends on, C3 wires the browser socket.
 *
 * `LiveHub` is one object satisfying three contracts at once:
 *
 * 1. **MUL-401 A-0's `TraceSink`** — `append(taskId, events)`, `head(taskId)`,
 *    `close(taskId)` and `subscribe(taskId, fromSeq, onEvents)`, imported from
 *    `@multiremi/api/trace/trace-sink.js`. A-0's final commit `43e41952` is merged
 *    into this branch, so these are the real signatures, not a transcription.
 * 2. **MUL-402 B1's `ConversationLogListener.onEntry(session_id, entry | patch)`**
 *    from `cmt_4dntxwh8ub1m`, with B0's row shape (still hand-written; see
 *    `./upstream-contracts.ts`).
 * 3. **The stream-key subscription** the browser socket (C3) and A-6 (C2) use:
 *    `subscribe("log:<session_id>" | "trace:<task_id>", fromSeq, onFrames)`.
 *
 * Two `subscribe` spellings, two result shapes
 * --------------------------------------------
 * Keys are the hub's own address space, so a keyed subscription reports the
 * missing range (`gap: {from, to}`) and the replica's freshness token
 * (`log_version`). A-0's `TraceSink` subscription, addressed by a bare task id,
 * reports `gap: boolean` and carries `head`/`closed` as **live getters** so a
 * subscriber that holds it for the life of a turn sees the head advance and the
 * trace close without re-subscribing. They are deliberately distinct — A-0 is
 * published and may not be widened — and TypeScript picks between them by the
 * *listener* type, because a `HubFrameListener` is not assignable to
 * `TraceSinkListener` or the other way round. The call combinations are pinned in
 * `tests/unit/multiremi/live-hub-contract.test.ts`.
 */

import { parseHubStreamKey } from "@multiremi/contracts/live-hub.js";
import type {
  HubFrame,
  HubFrameKind,
  HubFrameListener,
  HubSeqRange,
  HubStreamKey,
  HubStreamName,
  HubSubscription,
} from "@multiremi/contracts/live-hub.js";
import type {
  TraceEvent,
} from "@multiremi/contracts/trace.js";
import type {
  TraceSink,
  TraceSinkAppendResult,
  TraceSinkListener,
  TraceSinkSubscription,
} from "@multiremi/api/trace/trace-sink.js";
import type { HubTransport } from "./hub-transport.js";
// B0 only: A-0's stand-ins were replaced by the imports above when `43e41952`
// merged into this branch. See the header of that file for the removal condition.
import type { B0ConversationLogEntry } from "./upstream-contracts.js";

/**
 * The in-place update B1 emits after `revision++` (plan 2/6 §1): a hidden marker
 * or an edited row replaces part of an existing frame, and the frame keeps the
 * patched row's own `seq`.
 *
 * B0 published no patch type, and `cmt_4dntxwh8ub1m` fixes only the hook shape
 * `onEntry(session_id, entry | patch)`, so this is C0's reading of the plan.
 * 「待 B 确认」: B0 (MUL-425, PR #262) has not landed and is still being revised.
 * When it does, MUL-426's writer defines this shape and this interface is
 * replaced rather than extended.
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
 * `TraceSinkSubscription`. Order matters for the first case only, and the test
 * pins it so it cannot drift unnoticed.
 */
export interface LiveHub extends TraceSink, ConversationLogListener {
  /** Subscribe by stream key. `fromSeq` is inclusive; A-0's bare task id is exclusive. */
  subscribe(key: HubStreamKey, fromSeq: number, onFrames: HubFrameListener): HubSubscription;
  /** A-0's spelling: the same trace stream addressed by a bare task id. */
  subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription;

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
 * - `close` → records the task as closed, so a later `subscribe` reports
 *   `closed: true` even though nothing was ever appended. A-0 is explicit that
 *   this must not be a no-op: a zero-event turn, or a cold hub that sees the
 *   completion frame before any `trace.append`, would otherwise strand a
 *   subscriber that waits on `closed` forever;
 * - `subscribe*` → `first_seq: 1, head: 0` with an inert handle, no frames, and
 *   `head`/`closed` as live getters over this object's own state rather than
 *   snapshots, exactly as A-0's contract requires;
 * - `onEntry` / `subscribeHumanRequests` → no-op.
 *
 * C1 replaces every body. The signatures above are frozen here so C1/C2/C3 can be
 * written against them.
 */
export class EmptyLiveHub implements LiveHub {
  /**
   * Tasks A-0's `close` has finished, whether or not anything was appended.
   *
   * A `Set` rather than a flag on a stream state: the case `close` exists for is
   * precisely the task that has no state to hang a flag on.
   */
  private readonly closedTasks = new Set<string>();

  constructor(readonly transport: HubTransport) {}

  append(_taskId: string, _events: TraceEvent[]): TraceSinkAppendResult {
    // No ring and no sequence allocation: the head of an empty sink is 0, never a
    // number this class invented.
    return { head: 0 };
  }

  head(_taskId: string): number | null {
    return null;
  }

  /**
   * A-0's completeness signal. Establishes the closed state for a task nobody has
   * appended to as well — that is the case the flag exists for, since a turn with
   * zero events would otherwise leave a subscriber waiting on `closed` forever.
   */
  close(taskId: string): void {
    this.closedTasks.add(taskId);
  }

  /** Whether `close` has been called for this task. Test helper and C1 reference. */
  isClosed(taskId: string): boolean {
    return this.closedTasks.has(taskId);
  }

  subscribe(key: HubStreamKey, fromSeq: number, onFrames: HubFrameListener): HubSubscription;
  subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription;
  subscribe(
    keyOrTaskId: string,
    fromSeq: number,
    _onEvents: HubFrameListener | TraceSinkListener,
  ): HubSubscription | TraceSinkSubscription {
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
    // A-0's shape: `head` and `closed` are live getters over this hub's state, not
    // values captured at subscribe time, so a caller holding the subscription
    // across a turn sees `closed` flip. `head` is the number 0 rather than null
    // because the subscription contract types it as a number; `null` is what
    // `head(taskId)` answers for a task the sink has never seen.
    const closedTasks = this.closedTasks;
    return {
      first_seq: 1,
      get head() { return 0; },
      gap: false,
      get closed() { return closedTasks.has(keyOrTaskId); },
      unsubscribe: () => {},
    };
  }

  onEntry(_sessionId: string, _entry: B0ConversationLogEntry | ConversationLogPatch): void {
    // C1: enqueue into the `log:<session_id>` ring and schedule the fan-out.
  }

  subscribeHumanRequests(_workspaceId: string, _onEvent: HumanRequestListener): { unsubscribe(): void } {
    return { unsubscribe: () => {} };
  }
}

/**
 * Where each upstream contract stands relative to this file.
 *
 * A-0 is **aligned**: its final commit `43e41952` is merged into this branch and
 * the hub imports the real modules, so no A-0 stand-in is left.
 *
 * B0 is **pending**: PR #262 has not landed and is still being revised, so
 * `./upstream-contracts.ts` transcribes its row shape and `ConversationLogPatch`
 * is C0's reading of the plan. Exported (rather than only commented) so the
 * contract test asserts the promise still names a real commit and cannot be
 * quietly deleted while a stand-in remains.
 */
export const EMPTY_LIVE_HUB_ALIGNMENT_NOTES = [
  "A-0 aligned (MUL-401 final commit 43e41952, PR #261): the hub imports TraceEvent from @multiremi/contracts/trace.js and TraceSink/TraceSinkSubscription/TraceSinkListener from @multiremi/api/trace/trace-sink.js. No A-0 stand-in remains; upstream-contracts.ts is B0-only.",
  "B0 pending (MUL-425, PR #262, commit fe7810c9): replace upstream-contracts.ts B0ConversationLogEntry with @multiremi/contracts/conversation-log.js, and take MUL-426's patch type for ConversationLogPatch.",
] as const;

/** Build the empty hub with a caller-supplied transport. */
export function createEmptyLiveHub(transport: HubTransport): LiveHub {
  return new EmptyLiveHub(transport);
}

/** Re-exported so a caller can name a hub shape without reaching into contracts. */
export type {
  HubFrame,
  HubFrameKind,
  HubFrameListener,
  HubSeqRange,
  HubStreamKey,
  HubStreamName,
  HubSubscription,
};

/**
 * Deliberately NOT re-exported: `TraceEvent` and the `TraceSink*` types live in
 * their own modules now that A-0 is merged, and a copy here would be a second
 * name for the same thing. Import them from
 * `@multiremi/contracts/trace.js` and `@multiremi/api/trace/trace-sink.js`.
 */
export type { B0ConversationLogEntry };
