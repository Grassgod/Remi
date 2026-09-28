/**
 * The non-leader half (MUL-403 C7 §3).
 *
 * A tab that does not hold the lock reads through `BroadcastChannel`: it announces
 * `replica:open{session_id}` when it starts showing a session, asks the leader for
 * the window it needs, and re-reads when `replica:appended` says rows landed. It
 * never touches the Worker, the database or the socket, which is what keeps "one
 * subscription, one write path" true no matter how many tabs are open.
 *
 * The one thing it does own is a cache: the port's reads are synchronous, so the
 * last window the leader returned is what `getSnapshot` answers with, and an
 * `appended` message is what invalidates it.
 */

import type { ReplicaChannelMessage } from "./channel";
import type { SessionLogEntry, SessionReplicaPort, SessionReplicaSnapshot } from "./port";
import type { ReplicaView } from "./view";

export interface ReplicaFollowerOptions {
  view: ReplicaView;
  broadcast: (message: ReplicaChannelMessage) => void;
  /** Request ids, injectable so a test can be deterministic. */
  nextRequestId?: () => string;
  /** Answers a window request; in production this is a channel round trip. */
  requestWindow: (input: {
    requestId: string;
    sessionId: string;
    from: number;
    to: number;
  }) => void;
  /** The window the leader is showing by default; the list can ask for another. */
  defaultRange?: () => { from: number; to: number };
}

/**
 * A reader tab's replica port.
 *
 * `getSnapshot` answers from the cache, and the first read of a session triggers
 * the `replica:open` + `replica:query` pair. Until the leader answers, the
 * snapshot is `ready: false` — which is exactly the gate `useAnchoredReveal`
 * takes as `dataReady`, so a tab never claims a window it has not received.
 */
export class ReplicaFollower implements SessionReplicaPort {
  private readonly requested = new Set<string>();
  private readonly pending = new Map<string, { sessionId: string; from: number; to: number }>();
  private requestCounter = 0;

  constructor(private readonly options: ReplicaFollowerOptions) {}

  getSnapshot(sessionId: string): SessionReplicaSnapshot & { entries: readonly SessionLogEntry[] } {
    const snapshot = this.options.view.getSnapshot(sessionId);
    if (!snapshot.ready && !this.requested.has(sessionId)) {
      this.requested.add(sessionId);
      // Announce interest first: the leader refcounts opens, and a query for a
      // session the leader is not holding would race its own subscription.
      this.options.broadcast({ type: "replica:open", sessionId });
      this.request(sessionId);
    }
    return snapshot;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    return this.options.view.subscribe(sessionId, listener);
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.options.view.readRowHeight(sessionId, seq, key);
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    // Heights are produced by whichever tab measured the row, so a follower's
    // write has to reach the leader's database; the view keeps it locally too.
    this.options.view.writeRowHeight(sessionId, seq, key, height);
  }

  /** Ask the leader for a window (a deep link, or the tail the list needs). */
  request(sessionId: string, range?: { from: number; to: number }): void {
    const resolved = range ?? this.options.defaultRange?.() ?? { from: 0, to: Number.MAX_SAFE_INTEGER };
    const requestId = this.nextRequestId();
    this.pending.set(requestId, { sessionId, from: resolved.from, to: resolved.to });
    this.options.requestWindow({ requestId, sessionId, from: resolved.from, to: resolved.to });
  }

  /** Leave the session; the leader drops the subscription when the last tab does. */
  close(sessionId: string): void {
    this.requested.delete(sessionId);
    this.options.broadcast({ type: "replica:close", sessionId });
  }

  /**
   * Handle a leader broadcast.
   *
   * `appended` and `cleared` both invalidate rather than patch: the follower does
   * not know what a batch did to the rows it holds (a patch changes a row in
   * place, a hidden marker removes one), and re-reading a window is one message.
   */
  handle(message: ReplicaChannelMessage): void {
    switch (message.type) {
      case "replica:window": {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        this.options.view.setWindow(message.sessionId, message.entries, {
          head: message.snapshot.head,
          fresh: message.snapshot.fresh,
          ready: message.snapshot.ready,
        });
        return;
      }
      case "replica:appended": {
        if (!this.requested.has(message.sessionId)) return;
        this.request(message.sessionId);
        return;
      }
      case "replica:cleared": {
        this.options.view.dropAll();
        // Every open session is re-announced against the fresh database, which is
        // what makes the clear reach tabs the leader did not know about.
        for (const sessionId of [...this.requested]) {
          this.options.broadcast({ type: "replica:open", sessionId });
          this.request(sessionId);
        }
        return;
      }
      case "replica:leader": {
        // A new leader holds none of this tab's interest unless it is told, so
        // every open session is re-announced.
        for (const sessionId of [...this.requested]) {
          this.options.broadcast({ type: "replica:open", sessionId });
          this.request(sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return this.options.nextRequestId?.() ?? `req_${this.requestCounter}`;
  }
}
