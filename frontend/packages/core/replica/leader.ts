/**
 * Leader election and session refcounting (MUL-403 C7 §1, §3, §7).
 *
 * `navigator.locks.request(lockName, {mode: "exclusive"}, …)` is held for the
 * tab's whole life: the callback returns a promise that never settles, so the
 * lock is released exactly when the tab goes away and Chromium's lock queue wakes
 * the next holder. Measured handoff — next leader acquires the lock, reopens
 * SQLite and re-subscribes — is ~130 ms inside one browser context, inside the
 * plan's one-second budget.
 *
 * Refcounting is what makes "只有 1 页在订阅" true: a session is subscribed while at
 * least one tab has announced it open, and unsubscribed when the last one says
 * close. The set of open sessions is what a new leader re-subscribes from each
 * session's stored head; the plan requires that head to be contiguous, so
 * resuming from it can never skip a row.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import { replicaLockName, type ReplicaChannelMessage } from "./channel";
import type { SessionLogEntry } from "./port";
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from "./worker-protocol";

/** The subscription side of a session, provided by the page's socket (C3). */
export interface ReplicaSubscription {
  /** Sends `stream.subscribe{from_seq}`; the answer arrives through {@link ReplicaLeader.ack}. */
  subscribe(sessionId: string, fromSeq: number): void;
  unsubscribe(sessionId: string): void;
}

/** The page-side view the leader keeps in sync with the Worker. */
export interface LeaderView {
  setWindow(
    sessionId: string,
    entries: readonly SessionLogEntry[],
    options: { head?: number | null; fresh?: boolean; ready?: boolean },
  ): void;
  updateFreshness(sessionId: string, fresh: boolean): void;
  dropSession(sessionId: string): void;
  dropAll(): void;
}

export interface ReplicaLeaderOptions {
  userId: string;
  workspaceId: string;
  /** Tab identity, echoed in `replica:leader` so a tab can tell whether it holds the lock. */
  tabId: string;
  /** The page's replica socket. Owns the token, so it cannot live in the Worker. */
  subscription: ReplicaSubscription;
  /** Reads one range through the read route, for gaps and resets. */
  readRange: (sessionId: string, range: HubSeqRange) => Promise<SessionLogEntry[]>;
  /** The Worker, however the caller created it. */
  worker: {
    postMessage(message: ReplicaWorkerRequest): void;
    onMessage(listener: (message: ReplicaWorkerResponse) => void): () => void;
  };
  /** Broadcasts to the other tabs. */
  broadcast: (message: ReplicaChannelMessage) => void;
  /** The leader's own read cache, kept in step with the Worker. */
  view: LeaderView;
  /** Called once when the Worker reports it fell back to memory. */
  onDegraded?: (reason: string) => void;
  /** Called after a whole-database clear, so the tab can reset its views. */
  onCleared?: (reason: "logout" | "user_mismatch" | "schema_upgrade") => void;
}

/**
 * The leader half of the replica: refcounts, the backfill loop, and the
 * re-subscribe after a handoff.
 *
 * Every mutation goes through the Worker — one write path — and every read a
 * reader tab asks for is answered from the leader's view, so no tab but the
 * leader ever touches storage.
 */
export class ReplicaLeader {
  private readonly openCounts = new Map<string, number>();
  /**
   * Sessions with a read in flight.
   *
   * Serialized per session: two overlapping backfills would write the same range
   * twice and could interleave a frame batch between the read and its write,
   * which is how a replica ends up with a hole it reports as covered.
   */
  private readonly inFlight = new Set<string>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: ReplicaLeaderOptions) {}

  /**
   * Hold the lock for the tab's life.
   *
   * The promise inside the callback never settles on purpose: Web Locks releases
   * on the callback's promise settling, and a leader that returned early would
   * hand the lock to the next tab while its Worker still had the database open
   * (which `opfs-sahpool` answers with `NoModificationAllowedError`, since the
   * access handles are exclusive per origin).
   */
  async run(): Promise<void> {
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new Error("replica leader requires navigator.locks");
    await locks.request(replicaLockName(this.options.userId, this.options.workspaceId), { mode: "exclusive" }, async () => {
      this.disposers.push(
        this.options.worker.onMessage((message) => {
          void this.onWorkerMessage(message);
        }),
      );
      this.options.broadcast({ type: "replica:leader", tabId: this.options.tabId, sessions: [...this.openCounts.keys()] });
      await new Promise<never>(() => {});
    });
  }

  /**
   * A tab announces it is showing a session.
   *
   * The first announcement subscribes, later ones only bump the count — the
   * asymmetry is the acceptance criterion: three pages, one subscription.
   */
  open(sessionId: string): void {
    const count = this.openCounts.get(sessionId) ?? 0;
    this.openCounts.set(sessionId, count + 1);
    if (count > 0) return;
    this.options.worker.postMessage({ type: "open", sessionId });
  }

  /** The last close unsubscribes; an earlier one just decrements. */
  close(sessionId: string): void {
    const count = this.openCounts.get(sessionId) ?? 0;
    if (count > 1) {
      this.openCounts.set(sessionId, count - 1);
      return;
    }
    this.openCounts.delete(sessionId);
    if (count === 1) this.options.subscription.unsubscribe(sessionId);
  }

  /** Frames from the page's socket, forwarded to the Worker unread. */
  frames(sessionId: string, frames: readonly HubFrame[]): void {
    if (frames.length === 0) return;
    this.options.worker.postMessage({ type: "frames", sessionId, frames });
  }

  /** A `stream.ack`, forwarded so the Worker decides reset vs gap. */
  ack(sessionId: string, ack: HubStreamAckPayload): void {
    this.options.worker.postMessage({ type: "ack", sessionId, ack });
  }

  /** Fetch a window through the read route and store it (deep link / gap / SSR seed). */
  async loadWindow(sessionId: string, range: HubSeqRange): Promise<void> {
    await this.backfill(sessionId, range);
  }

  /** Row heights, written through the Worker so the leader stays the only writer. */
  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.options.worker.postMessage({ type: "writeHeight", sessionId, seq, key, height });
  }

  /** Drop everything: logout, a user mismatch or a schema upgrade. */
  clear(reason: "logout" | "user_mismatch" | "schema_upgrade"): void {
    this.options.worker.postMessage({ type: "clear", reason });
  }

  /** Sessions this leader holds, for the handoff announcement. */
  get sessions(): string[] {
    return [...this.openCounts.keys()];
  }

  /** Whether the tab still holds the lock (false after a handoff or a dispose). */
  get active(): boolean {
    return !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  private async onWorkerMessage(message: ReplicaWorkerResponse): Promise<void> {
    switch (message.type) {
      case "ready": {
        // The fallback is logged once, per plan 3/6 §1: no user-visible prompt.
        if (message.storage === "memory" && message.degraded) this.options.onDegraded?.(message.degraded);
        return;
      }
      case "opened": {
        if (message.cleared) this.clearAndBroadcast(message.cleared);
        // Step 1: subscribe from the head the database reached. On a handoff this
        // is the resume point, which is why the head has to be contiguous.
        this.options.subscription.subscribe(message.sessionId, message.fromSeq);
        return;
      }
      case "backfill": {
        // Step 2: a gap (or a reset) is read through the read route, written into
        // the replica, and only then can the stream continue without a hole.
        if (message.range) await this.backfill(message.sessionId, message.range);
        return;
      }
      case "appended": {
        this.options.view.updateFreshness(message.sessionId, message.fresh);
        this.options.broadcast({
          type: "replica:appended",
          sessionId: message.sessionId,
          range: message.range ?? { from: 0, to: 0 },
          head: message.head,
          fresh: message.fresh,
        });
        // A hole the batch exposed is filled before anything else: the next batch
        // would otherwise sit above it and the head would stop advancing.
        if (message.missing) await this.backfill(message.sessionId, message.missing);
        return;
      }
      case "windowResult": {
        this.options.view.setWindow(message.sessionId, message.entries, {
          head: message.head,
          fresh: message.fresh,
          ready: message.ready,
        });
        return;
      }
      case "cleared": {
        this.clearAndBroadcast(message.reason);
        return;
      }
      case "error": {
        // Reported, never swallowed: a replica that silently stops writing looks
        // exactly like a stream that stopped sending.
        this.options.onDegraded?.(`worker ${message.request ?? "request"}: ${message.message}`);
        return;
      }
      default:
        return;
    }
  }

  private clearAndBroadcast(reason: "logout" | "user_mismatch" | "schema_upgrade"): void {
    this.options.view.dropAll();
    this.options.onCleared?.(reason);
    this.options.broadcast({ type: "replica:cleared", reason });
  }

  /**
   * Read `range` through the read route and store it.
   *
   * The Worker answers with the window it now holds, so the leader's view is
   * refreshed from storage rather than patched locally — the row set a read
   * returns and the row set SQLite keeps are then the same set by construction.
   */
  private async backfill(sessionId: string, range: HubSeqRange): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    try {
      const entries = await this.options.readRange(sessionId, range);
      this.options.worker.postMessage({ type: "writeWindow", sessionId, entries, range });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
