/**
 * The leader half of the replica: refcounts and the backfill loop (MUL-403 C7
 * §1, §3, §7).
 *
 * The lock itself is taken by `ReplicaFacade` in `browser.ts`, because the tab
 * that wins it may already have been reading as a follower; this class starts
 * once the tab knows it leads.
 *
 * Refcounting is what makes "只有 1 页在订阅" true: a session is subscribed while at
 * least one tab has it open, and unsubscribed when the last one closes it. The
 * set of open sessions is what a new leader re-subscribes from each session's
 * stored head; the plan requires that head to be contiguous, so resuming from it
 * can never skip a row.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { ReplicaChannelMessage } from "./channel";
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
  /** The current window, read synchronously (the port's contract). */
  snapshot(sessionId: string): {
    entries: readonly SessionLogEntry[];
    head: number | null;
    fresh: boolean;
    ready: boolean;
  };
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
 * The leader half of the replica.
 *
 * Every mutation goes through the Worker — one write path — and every read a
 * reader tab asks for is answered from the leader's view, so no tab but the
 * leader ever touches storage.
 */
export class ReplicaLeader {
  private readonly openCounts = new Map<string, number>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly tokens = new Map<string, string>();
  private readonly pendingOpens = new Set<string>();
  private generation = 0;
  private epoch = 0;
  private clearing = false;
  private writeCounter = 0;
  private readonly writes = new Map<string, { sessionId: string; resolve: () => void }>();
  /**
   * Sessions with a read in flight.
   *
   * Serialized per session: two overlapping backfills would write the same range
   * twice and could interleave a frame batch between the read and its write,
   * which is how a replica ends up with a hole it reports as covered.
   */
  private readonly inFlight = new Map<string, {
    token: string | undefined; current: HubSeqRange | null; ranges: HubSeqRange[]; done: Promise<void>;
  }>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: ReplicaLeaderOptions) {}

  /**
   * A tab announces it is showing a session.
   *
   * The first announcement subscribes, later ones only bump the count — the
   * asymmetry is the acceptance criterion: three pages, one subscription.
   */
  open(sessionId: string, ownerId?: string): void {
    if (this.disposed) return;
    if (ownerId !== undefined) {
      const owners = this.owners.get(sessionId) ?? new Set<string>();
      if (owners.has(ownerId)) return;
      owners.add(ownerId);
      this.owners.set(sessionId, owners);
    }
    const count = this.openCounts.get(sessionId) ?? 0;
    this.openCounts.set(sessionId, count + 1);
    if (count > 0) return;
    this.requestOpen(sessionId);
  }

  /**
   * Re-run step 1 for a session the page still has open.
   *
   * This is the reconnect path, and the plan spells it out: 重连即回到第 1 步，因为
   * `from_seq` 来自库. The socket handshake is re-done by the page, so it asks the
   * leader to open the session again; the Worker answers with `fromSeq` computed
   * from the stored head, and only the frames above it are re-sent. Asking for
   * `1` here is the bug this method exists to prevent — it would re-read the whole
   * log on every reconnect and still call the result fresh.
   */
  resubscribe(sessionId: string): void {
    if (!this.openCounts.has(sessionId)) return;
    this.requestOpen(sessionId);
  }

  /** The last close unsubscribes; an earlier one just decrements. */
  close(sessionId: string, ownerId?: string): void {
    if (ownerId !== undefined && !this.owners.get(sessionId)?.delete(ownerId)) return;
    const count = this.openCounts.get(sessionId) ?? 0;
    if (count > 1) {
      this.openCounts.set(sessionId, count - 1);
      return;
    }
    this.openCounts.delete(sessionId);
    this.owners.delete(sessionId);
    this.tokens.delete(sessionId);
    this.pendingOpens.delete(sessionId);
    this.cancelWrites(sessionId);
    if (count === 1) this.options.subscription.unsubscribe(sessionId);
  }

  /** Frames from the page's socket, forwarded to the Worker unread. */
  frames(sessionId: string, frames: readonly HubFrame[]): void {
    if (frames.length === 0 || !this.openCounts.has(sessionId)) return;
    this.post({ type: "frames", sessionId, frames });
  }

  /** A `stream.ack`, forwarded so the Worker decides reset vs gap. */
  ack(sessionId: string, ack: HubStreamAckPayload): void {
    if (!this.openCounts.has(sessionId)) return;
    this.options.view.updateFreshness(sessionId, false);
    this.options.broadcast({ type: "replica:ack", sessionId, ack });
    this.post({ type: "ack", sessionId, ack });
  }

  /** Fetch a window through the read route and store it (deep link / gap / SSR seed). */
  async loadWindow(sessionId: string, range: HubSeqRange): Promise<void> {
    await this.backfill(sessionId, range);
  }

  async queryWindow(sessionId: string, from: number, to: number): Promise<ReturnType<ReplicaLeader["window"]>> {
    const cached = this.window(sessionId, from, to);
    if (from > 0 && to < Number.MAX_SAFE_INTEGER && to >= from && cached.entries.length !== to - from + 1) {
      await this.loadWindow(sessionId, { from, to });
    }
    return this.window(sessionId, from, to);
  }

  /**
   * The window a reader tab asked for.
   *
   * Answered from the leader's view, which the Worker keeps in step: the port's
   * reads are synchronous, so a follower's request can only be served from
   * something already in memory. A request outside the view (a deep link into rows
   * the leader never read) is served by `loadWindow` first, which is the one path
   * that touches the read route.
   */
  window(sessionId: string, from: number, to: number): {
    entries: SessionLogEntry[];
    head: number | null;
    fresh: boolean;
    ready: boolean;
  } {
    const snapshot = this.options.view.snapshot(sessionId);
    return {
      entries: snapshot.entries.filter((entry) => entry.seq >= from && entry.seq <= to),
      head: snapshot.head,
      fresh: snapshot.fresh,
      ready: snapshot.ready,
    };
  }

  /** Row heights, written through the Worker so the leader stays the only writer. */
  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.post({ type: "writeHeight", sessionId, seq, key, height });
  }

  /** Drop everything: logout, a user mismatch or a schema upgrade. */
  clear(reason: "logout" | "user_mismatch" | "schema_upgrade"): void {
    if (this.disposed || this.clearing) return;
    this.clearing = true;
    this.invalidateDatabase();
    this.post({ type: "clear", reason });
  }

  /**
   * Feed one Worker response back into the leader.
   *
   * The Worker's answers are what advance the state machine — `opened` triggers
   * the subscribe, `backfill` triggers the read, `appended` broadcasts and fills
   * the hole it exposed — so this is the leader's public input, wired by
   * `browser.ts` to the Worker's `onMessage`.
   */
  handleWorkerMessage(message: ReplicaWorkerResponse): void {
    void this.onWorkerMessage(message).catch((error: unknown) => {
      this.options.onDegraded?.(`replica read: ${error instanceof Error ? error.message : String(error)}`);
    });
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
    for (const sessionId of this.openCounts.keys()) this.options.subscription.unsubscribe(sessionId);
    this.openCounts.clear();
    this.owners.clear();
    this.tokens.clear();
    this.pendingOpens.clear();
    this.cancelWrites();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  private async onWorkerMessage(message: ReplicaWorkerResponse): Promise<void> {
    if (this.disposed) return;
    if (message.epoch !== undefined && message.epoch !== this.epoch) return;
    if ("sessionId" in message && (!message.token || !this.isCurrent(message.sessionId, message.token))) return;
    switch (message.type) {
      case "ready": {
        // The fallback is logged once, per plan 3/6 §1: no user-visible prompt.
        if (message.storage === "memory" && message.degraded) this.options.onDegraded?.(message.degraded);
        return;
      }
      case "opened": {
        if (!this.pendingOpens.delete(message.sessionId)) return;
        if (message.cleared) { this.clearAndBroadcast(message.cleared); return; }
        // Paint what the database already held before the socket answers: on a
        // takeover this is the previous leader's window, and showing it is what
        // keeps the handoff from flashing an empty list.
        this.options.view.setWindow(message.sessionId, message.entries, {
          head: message.head,
          fresh: message.fresh,
          ready: message.entries.length > 0 || message.head !== null,
        });
        // Step 1: subscribe from the head the database reached. On a handoff this
        // is the resume point, which is why the head has to be contiguous.
        this.options.subscription.subscribe(message.sessionId, message.fromSeq);
        return;
      }
      case "backfill": {
        this.options.view.setWindow(message.sessionId, message.entries, {
          head: message.head, fresh: message.fresh, ready: message.ready,
        });
        this.options.broadcast({ type: "replica:appended", sessionId: message.sessionId,
          range: { from: 0, to: 0 }, head: message.head, fresh: message.fresh });
        if (message.reset) this.resubscribe(message.sessionId);
        // Step 2: a gap (or a reset) is read through the read route, written into
        // the replica, and only then can the stream continue without a hole.
        if (message.range) await this.backfill(message.sessionId, message.range);
        return;
      }
      case "appended": {
        this.options.view.setWindow(message.sessionId, message.entries, {
          head: message.head,
          fresh: message.fresh,
          // Rows arrived, so the replica has answered for this session: the
          // `dataReady` gate `useAnchoredReveal` takes must open even when the
          // window is still short of the head.
          ready: true,
        });
        this.options.broadcast({
          type: "replica:appended",
          sessionId: message.sessionId,
          range: message.range ?? { from: 0, to: 0 },
          head: message.head,
          fresh: message.fresh,
        });
        if (message.requestId) {
          this.writes.get(message.requestId)?.resolve();
          this.writes.delete(message.requestId);
        }
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
        if (message.requestId) {
          this.writes.get(message.requestId)?.resolve();
          this.writes.delete(message.requestId);
        }
        // Reported, never swallowed: a replica that silently stops writing looks
        // exactly like a stream that stopped sending.
        this.options.onDegraded?.(`worker ${message.request ?? "request"}: ${message.message}`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Post to the Worker.
   *
   * No queue here: the Worker serializes its own requests (`ReplicaWorkerHost.
   * enqueue`), so an `open` posted right after `init` is handled after the engine
   * exists without this side having to know when that happens.
   */
  private post(request: ReplicaWorkerRequest): void {
    if (this.disposed) return;
    this.options.worker.postMessage({ ...request, epoch: this.epoch,
      ...("sessionId" in request ? { token: this.tokens.get(request.sessionId) } : {}),
    });
  }

  private requestOpen(sessionId: string): void {
    this.tokens.set(sessionId, `${this.options.tabId}:${++this.generation}`);
    this.pendingOpens.add(sessionId);
    this.post({ type: "open", sessionId });
  }

  private isCurrent(sessionId: string, token?: string): boolean {
    return !this.disposed && this.openCounts.has(sessionId)
      && (token === undefined || token === this.tokens.get(sessionId));
  }

  private clearAndBroadcast(reason: "logout" | "user_mismatch" | "schema_upgrade"): void {
    if (!this.clearing) this.invalidateDatabase();
    this.clearing = false;
    this.options.view.dropAll();
    this.options.onCleared?.(reason);
    this.options.broadcast({ type: "replica:cleared", reason });
    if (reason !== "logout") {
      for (const sessionId of this.openCounts.keys()) this.resubscribe(sessionId);
    }
  }

  private invalidateDatabase(): void {
    this.epoch += 1;
    for (const sessionId of this.openCounts.keys()) this.tokens.set(sessionId, `${this.options.tabId}:${++this.generation}`);
    this.pendingOpens.clear();
    this.cancelWrites();
    this.options.view.dropAll();
  }

  /**
   * Read `range` through the read route and store it.
   *
   * The Worker answers with the window it now holds, so the leader's view is
   * refreshed from storage rather than patched locally — the row set a read
   * returns and the row set SQLite keeps are then the same set by construction.
   */
  private async backfill(sessionId: string, range: HubSeqRange): Promise<void> {
    if (!this.isCurrent(sessionId)) return;
    const token = this.tokens.get(sessionId);
    const existing = this.inFlight.get(sessionId);
    if (existing && existing.token === token) {
      if (![existing.current, ...existing.ranges].some(r => r?.from === range.from && r.to === range.to)) existing.ranges.push(range);
      return existing.done;
    }
    const flight = { token, current: null as HubSeqRange | null, ranges: [range], done: Promise.resolve() };
    this.inFlight.set(sessionId, flight);
    flight.done = (async () => {
      try {
        while (flight.ranges.length > 0 && this.isCurrent(sessionId, token)) {
          flight.current = flight.ranges.shift()!;
          const entries = await this.options.readRange(sessionId, flight.current);
          if (!this.isCurrent(sessionId, token)) return;
          const requestId = `${this.options.tabId}:write:${++this.writeCounter}`;
          const written = new Promise<void>((resolve) => { this.writes.set(requestId, { sessionId, resolve }); });
          this.post({ type: "writeWindow", sessionId, entries, range: flight.current, requestId });
          await written;
        }
      } finally {
        if (this.inFlight.get(sessionId) === flight) this.inFlight.delete(sessionId);
      }
    })();
    return flight.done;
  }

  private cancelWrites(sessionId?: string): void {
    for (const [id, write] of this.writes) {
      if (sessionId !== undefined && write.sessionId !== sessionId) continue;
      write.resolve(); this.writes.delete(id);
    }
  }
}
