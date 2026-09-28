/**
 * The hub as A-0's `TraceSink` (MUL-403 §2 item 1).
 *
 * `HubImpl` already implements the `TraceSink` surface, so this file is not an
 * extra implementation — it is the *boundary* C3 (the browser trace socket) and
 * A-6 (the daemon handler) import, and the place where the three rules that
 * distinguish a trace subscription from a log subscription are stated once:
 *
 * 1. **The sequence is the daemon's.** `append` stores what it is given; it never
 *    renumbers and never fills a gap by inventing numbers. `seq <= head` is a
 *    replay (dropped and counted), and a jump waits 500ms in the continuity buffer
 *    before the reader is asked to close it.
 * 2. **`head` and `closed` are live.** A caller that holds one subscription for the
 *    life of a turn must see the head move and the trace close without
 *    re-subscribing, so both are getters over hub state rather than snapshots.
 * 3. **`close` works for a task that never appended.** A zero-event turn, or a cold
 *    hub that sees the completion frame before any `trace.append`, must still be
 *    able to flip `closed`, or a subscriber waits forever.
 *
 * ## Trace streams do not cross processes
 *
 * A `trace:` stream lives in the runtime process the daemon is connected to. The
 * browser reaches it through `/api/trace/ws` (C3), which nginx routes to runtime,
 * so trace bytes never enter the peer channel. That is why nothing in this file
 * (or in `hub-core.ts`) ever publishes a `trace:` frame to the transport: the
 * `kind: "trace"` guard in `HubImpl.append` is the single place that decides it.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type {
  TraceSink,
  TraceSinkAppendResult,
  TraceSinkListener,
  TraceSinkSubscription,
} from "@multiremi/api/trace/trace-sink.js";
import type { HubImpl } from "./hub-core.js";

/**
 * A trace-only view of a hub.
 *
 * Deliberately narrow: a consumer that needs the trace sink must not be able to
 * reach the log ring through this handle, so C3's socket and A-6's daemon handler
 * take exactly the surface they use. It is the `TraceSink` interface unchanged —
 * no `subscribeKey` convenience, because the two spellings on `HubImpl` return two
 * different subscription shapes and a caller that silently got the wrong one would
 * lose `closed`, which is the whole point of A-0's spelling.
 */
export type HubTraceSink = TraceSink;

/** Wrap a hub as the trace sink C3 and A-6 consume. */
export function createHubTraceSink(hub: HubImpl): HubTraceSink {
  return {
    append(taskId: string, events: TraceEvent[]): TraceSinkAppendResult {
      return hub.append(taskId, events);
    },
    head(taskId: string): number | null {
      return hub.head(taskId);
    },
    subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription {
      return hub.subscribe(taskId, fromSeq, onEvents);
    },
    close(taskId: string): void {
      hub.close(taskId);
    },
  };
}

/**
 * The rules above, in executable form, so a future edit that breaks one is a
 * failing test rather than a paragraph nobody re-reads.
 */
export const TRACE_SINK_ADAPTER_NOTES = [
  "append stores the daemon's own seq; the hub never renumbers and never invents a number to close a gap",
  "head and closed are live getters over hub state, not values captured at subscribe time",
  "close(taskId) establishes closed for a task that was never appended to",
  "trace streams stay in the process the daemon is connected to; nothing here publishes them to a peer",
  "consumers subscribe with the bare task id (`TraceSink`'s spelling) so they get `closed`; the keyed spelling is for the browser socket, which carries its own gap range",
] as const;
