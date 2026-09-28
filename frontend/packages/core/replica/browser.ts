/**
 * The browser entry point (MUL-403 C7 §1, §2, §6).
 *
 * One call, `openBrowserReplica`, decides everything the plan specifies per
 * browser rather than per tab:
 *
 * 1. take `navigator.locks.request("remi-replica:<user>:<ws>")`; the holder is the
 *    leader (scope item 1);
 * 2. the leader starts the DedicatedWorker, opens the `opfs-sahpool` database in
 *    it, subscribes through the page's socket and writes frames through the
 *    Worker (scope items 2–3);
 * 3. every tab reads through the BroadcastChannel; a non-leader asks the leader and
 *    caches the answer (scope item 3);
 * 4. when OPFS or Web Locks is unavailable the same protocol runs over memory
 *    (scope item 6), with no persistence and no sharing.
 *
 * One database per `(user, workspace)` and one write path per browser: the
 * filename encodes the pair, and a leader that finds another user's database
 * clears it before it serves a row.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import { replicaLockName, type ReplicaChannelMessage } from "./channel";
import { ReplicaEngine, type ReplicaClearEvent } from "./engine";
import { ReplicaFollower } from "./follower";
import { ReplicaLeader } from "./leader";
import { MemoryReplicaStorage } from "./storage";
import { ReplicaView } from "./view";
import type { SessionLogEntry, SessionReplicaPort } from "./port";
import { rangeOfFrames } from "./frames";
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from "./worker-protocol";

/** A browser Worker, narrowed to what the replica uses. */
export interface ReplicaWorkerLike {
  postMessage(message: ReplicaWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** The browser capabilities this module depends on, injectable for tests. */
export interface BrowserReplicaEnv {
  locks?: LockManager;
  broadcastChannel?: new (name: string) => BroadcastChannel;
  createWorker?: () => ReplicaWorkerLike;
  /** Whether OPFS exists; `false` sends the leader straight to memory. */
  hasOpfs?: boolean;
}

export interface BrowserReplicaOptions {
  userId: string;
  workspaceId: string;
  /** Unique per tab, so a tab can recognise the leader's own broadcast. */
  tabId: string;
  /** The page's socket subscription (C3). The token lives in the page. */
  subscribe: (sessionId: string, fromSeq: number) => void;
  unsubscribe: (sessionId: string) => void;
  /** Reads a range through the read route; used for gaps, resets and deep links. */
  readRange: (sessionId: string, range: HubSeqRange) => Promise<SessionLogEntry[]>;
  env?: BrowserReplicaEnv;
  /** Logged once when the replica runs without OPFS. */
  onDegraded?: (reason: string) => void;
  /** Called after a whole-database clear, for the tab's own state. */
  onCleared?: (reason: ReplicaClearEvent["reason"]) => void;
}

export interface BrowserReplica {
  /** The port the list renders through, whoever this tab turns out to be. */
  port: SessionReplicaPort;
  /** Show a session; refcounted on the leader and announced from a follower. */
  open(sessionId: string): void;
  close(sessionId: string): void;
  /**
   * Re-subscribe an open session after the socket reconnected.
   *
   * The plan's catch-up path: the page re-establishes the socket, then asks the
   * replica for the position it already holds, so the replay is the missing tail
   * and not the whole log.
   */
  resubscribe(sessionId: string): void;
  /** A deep link or a scroll window: fetch through the read route and store it. */
  loadWindow(sessionId: string, range: HubSeqRange): Promise<void>;
  /** Feed the socket's frames and acks. */
  frames(sessionId: string, frames: readonly HubFrame[]): void;
  ack(sessionId: string, ack: HubStreamAckPayload): void;
  /** Drop everything (logout, user mismatch, schema upgrade). */
  clear(reason: ReplicaClearEvent["reason"]): void;
  /** Whether this tab holds the lock. */
  readonly isLeader: boolean;
  /** The storage the leader opened; `null` on a follower. */
  readonly storage: "opfs" | "memory" | null;
  /** Whether the leader had to use memory despite asking for OPFS. */
  readonly degraded: boolean;
  dispose(): void;
}

/** Whether the browser can run the persistent path (scope item 6). */
export function replicaCapabilities(env: BrowserReplicaEnv = {}): { opfs: boolean; locks: boolean } {
  const locks = env.locks ?? (globalThis.navigator as Navigator | undefined)?.locks;
  const hasOpfs =
    env.hasOpfs ??
    (typeof globalThis.navigator !== "undefined" &&
      typeof (globalThis.navigator as Navigator).storage?.getDirectory === "function");
  return { opfs: hasOpfs, locks: typeof locks?.request === "function" };
}

/**
 * Open the replica for one `(user, workspace)`.
 *
 * The returned port is the same shape in every tab; only the implementation
 * behind it differs, so the list is written once. The returned promise resolves
 * as soon as the tab knows whether it leads — a follower does not wait for the
 * leader's database to open.
 */
export async function openBrowserReplica(options: BrowserReplicaOptions): Promise<BrowserReplica> {
  const env = options.env ?? {};
  const { locks: hasLocks } = replicaCapabilities(env);
  const view = new ReplicaView();

  // No Web Locks or no OPFS: every tab runs its own replica. The plan's fallback,
  // and the protocol is unchanged — only the sharing and the hot start are gone.
  //
  // OPFS is checked on the *page* too, because a page that lacks it cannot expect
  // its Worker to have it; the Worker checks again regardless, since a page can
  // have the API and still be refused (private mode, a denied store).
  if (!hasLocks || !replicaCapabilities(env).opfs) {
    options.onDegraded?.(
      !hasLocks
        ? "navigator.locks unavailable; running a per-tab memory replica"
        : "OPFS unavailable; running a per-tab memory replica",
    );
    return createMemoryTabsReplica(options, view);
  }

  const identityKey = replicaLockName(options.userId, options.workspaceId);
  const channel = env.broadcastChannel
    ? new env.broadcastChannel(identityKey)
    : typeof BroadcastChannel === "function"
      ? new BroadcastChannel(identityKey)
      : null;
  const facade = new ReplicaFacade(options, env, view, channel);
  facade.start();
  return facade;
}

/**
 * One tab's replica, which is a follower until the Web Lock is granted.
 *
 * The role is deliberately mutable. A tab that is not the leader must still be
 * able to *become* the leader when the holder's tab goes away: `navigator.locks`
 * grants the queued request at that moment, and the tab that was reading through
 * the BroadcastChannel switches to owning the Worker and the subscription. Making
 * the role immutable would either block the first paint on a lock a dying tab
 * still holds, or lose the handoff entirely.
 */
class ReplicaFacade implements BrowserReplica {
  private leader: LeaderSession | null = null;
  private readonly follower: ReplicaFollower;
  private readonly wanted = new Set<string>();
  /** Sockets/tabs seen since the last `replica:leader`, to detect a new holder. */
  private lastLeaderTabId: string | null = null;
  private degradedReason: string | null = null;
  private disposed = false;
  private requestCounter = 0;

  constructor(
    private readonly options: BrowserReplicaOptions,
    private readonly env: BrowserReplicaEnv,
    private readonly view: ReplicaView,
    private readonly channel: BroadcastChannel | null,
  ) {
    this.follower = new ReplicaFollower({
      view,
      broadcast: (message) => this.broadcast(message),
      requestWindow: (input) => this.broadcast({ type: "replica:query", ...input }),
      onCleared: options.onCleared,
      nextRequestId: () => `${options.tabId}:${++this.requestCounter}`,
    });
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as ReplicaChannelMessage;
        if (this.disposed || message.identityKey !== replicaLockName(this.options.userId, this.options.workspaceId)) return;
        if (message.senderTabId === this.options.tabId) return;
        // A tab must not act on its own broadcast: the leader would open a
        // session twice and the refcount would never reach zero.
        if (message.type === "replica:leader" && message.tabId === this.options.tabId) return;
        if (message.type === "replica:leader") this.lastLeaderTabId = message.tabId;

        // The role decides how an incoming message is handled, not the message:
        //   * a leader must ANSWER the read requests and record the open/close
        //     announcements the other tabs make — feed them to a follower and it
        //     would ask itself for a window through a channel nobody is
        //     listening to on the other end;
        //   * a follower must SEND those requests and consume the answers.
        if (this.leader) {
          this.handleAsLeader(message);
          return;
        }
        this.follower.handle(message);
      };
    }
  }

  /** The leader side of the channel protocol. */
  private handleAsLeader(message: ReplicaChannelMessage): void {
    const leader = this.leader;
    if (!leader) return;
    switch (message.type) {
      case "replica:open": {
        // Another tab is showing this session; refcount it so the subscription
        // outlives whichever tab is in front.
        leader.leader.open(message.sessionId, message.senderTabId);
        return;
      }
      case "replica:close": {
        leader.leader.close(message.sessionId, message.senderTabId);
        return;
      }
      case "replica:rowHeight": {
        // The leader's view is its read cache, and the Worker is what persists.
        leader.leader.writeRowHeight(message.sessionId, message.seq, message.key, message.height);
        this.view.writeRowHeight(message.sessionId, message.seq, message.key, message.height);
        return;
      }
      case "replica:query": {
        const view = leader.leader.window(message.sessionId, message.from, message.to);
        this.broadcast({
          type: "replica:window",
          requestId: message.requestId,
          sessionId: message.sessionId,
          entries: view.entries,
          snapshot: { head: view.head, fresh: view.fresh, ready: view.ready },
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Queue for the lock and, when it is granted, become the leader.
   *
   * One request, no probe: `navigator.locks.request` keeps the promise pending
   * until the lock is free, so the same call both wins an uncontended lock
   * immediately and becomes the takeover path when the holder's tab dies. The
   * callback never returns while the tab lives, which is what holds the lock.
   */
  start(): void {
    const locks = this.env.locks ?? (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) return;
    void locks
      .request(replicaLockName(this.options.userId, this.options.workspaceId), { mode: "exclusive" }, async () => {
        if (this.disposed) return;
        await this.becomeLeader();
        await new Promise<never>(() => {});
      })
      .catch(() => {
        // A rejected lock request means this tab never leads; it stays a follower,
        // which is the safe side of the split.
      });
  }

  private async becomeLeader(): Promise<void> {
    const session = await startLeader(this.options, this.env, this.view, (message) => this.broadcast(message), this.wanted);
    if (this.disposed) {
      session.leader.dispose();
      session.bridge.terminate?.();
      return;
    }
    this.follower.suspend();
    this.leader = session;
    this.degradedReason = session.degraded ? "leader opened without OPFS" : null;
    this.broadcast({ type: "replica:leader", tabId: this.options.tabId, sessions: [...this.wanted] });
    // Every session this tab is showing must be subscribed by *somebody*; the tab
    // that just took over is now that somebody.
    for (const sessionId of this.wanted) this.leader.leader.open(sessionId, this.options.tabId);
  }

  get port(): SessionReplicaPort {
    return this.leader ? this.view : this.follower;
  }

  open(sessionId: string): void {
    if (this.disposed) return;
    if (this.wanted.has(sessionId)) return;
    this.wanted.add(sessionId);
    if (this.leader) {
      this.leader.leader.open(sessionId, this.options.tabId);
      return;
    }
    // A follower's interest is announced over the channel; the leader refcounts
    // it and subscribes once, for every tab showing the session.
    this.follower.open(sessionId);
  }

  close(sessionId: string): void {
    if (!this.wanted.delete(sessionId)) return;
    if (this.leader) {
      this.leader.leader.close(sessionId, this.options.tabId);
      return;
    }
    this.follower.close(sessionId);
  }

  resubscribe(sessionId: string): void {
    // Only the leader holds the socket, so only the leader re-subscribes; a
    // follower's window arrives through the channel either way.
    this.leader?.leader.resubscribe(sessionId);
  }

  async loadWindow(sessionId: string, range: HubSeqRange): Promise<void> {
    if (this.leader) {
      await this.leader.leader.loadWindow(sessionId, range);
      return;
    }
    this.follower.request(sessionId, range);
  }

  frames(sessionId: string, frames: readonly HubFrame[]): void {
    this.leader?.leader.frames(sessionId, frames);
  }

  ack(sessionId: string, ack: HubStreamAckPayload): void {
    this.leader?.leader.ack(sessionId, ack);
  }

  clear(reason: ReplicaClearEvent["reason"]): void {
    if (this.leader) {
      this.leader.leader.clear(reason);
      return;
    }
    // A follower cannot delete the database; the leader's `replica:cleared`
    // broadcast is what drops every tab's cache.
    this.view.dropAll();
  }

  get isLeader(): boolean {
    return this.leader !== null;
  }

  get storage(): "opfs" | "memory" | null {
    return this.leader?.storage ?? null;
  }

  get degraded(): boolean {
    return this.degradedReason !== null;
  }

  /** The tab that held the lock when this tab last heard from one, for diagnostics. */
  get leaderTabId(): string | null {
    return this.lastLeaderTabId;
  }

  dispose(): void {
    if (this.disposed) return;
    this.follower.dispose();
    this.disposed = true;
    this.leader?.leader.dispose();
    this.leader?.bridge.terminate?.();
    this.channel?.close();
  }

  broadcast(message: ReplicaChannelMessage): void {
    if (this.disposed) return;
    this.channel?.postMessage({
      ...message,
      identityKey: replicaLockName(this.options.userId, this.options.workspaceId),
      senderTabId: this.options.tabId,
    });
  }
}

/** A replica with no lock and no Worker: same protocol, per tab, in memory. */
function createMemoryTabsReplica(options: BrowserReplicaOptions, view: ReplicaView): BrowserReplica {
  const engine = new ReplicaEngine(new MemoryReplicaStorage());
  const openSessions = new Set<string>();

  const refreshView = (sessionId: string): void => {
    const snapshot = engine.snapshot(sessionId);
    view.setWindow(sessionId, engine.readWindow(sessionId, 0, Number.MAX_SAFE_INTEGER), {
      head: snapshot.head,
      fresh: snapshot.fresh,
      ready: snapshot.ready,
    });
  };

  return {
    port: view,
    open: (sessionId) => {
      if (openSessions.has(sessionId)) return;
      openSessions.add(sessionId);
      const opened = engine.openSession({ sessionId, userId: options.userId, workspaceId: options.workspaceId });
      options.subscribe(sessionId, opened.fromSeq);
      refreshView(sessionId);
    },
    close: (sessionId) => {
      if (!openSessions.delete(sessionId)) return;
      options.unsubscribe(sessionId);
    },
    resubscribe: (sessionId) => {
      if (!openSessions.has(sessionId)) return;
      // Same rule as the shared path: the cursor is the stored head, never 1.
      options.subscribe(sessionId, engine.resumeFrom(sessionId));
    },
    loadWindow: async (sessionId, range) => {
      const entries = await options.readRange(sessionId, range);
      engine.writeWindow(sessionId, entries, range);
      refreshView(sessionId);
    },
    frames: (sessionId, frames) => {
      engine.frames(sessionId, frames);
      refreshView(sessionId);
    },
    ack: (sessionId, ack) => {
      engine.ack(sessionId, ack);
      refreshView(sessionId);
    },
    clear: (reason) => {
      engine.clear(reason);
      view.dropAll();
    },
    isLeader: true,
    storage: "memory",
    degraded: true,
    dispose: () => engine.close(),
  };
}

interface LeaderSession {
  leader: ReplicaLeader;
  bridge: WorkerBridge;
  storage: "opfs" | "memory";
  degraded: boolean;
}

/**
 * Try to take the lock.
 *
 * A tab that does not get it resolves to null immediately: the winner holds the
 * lock for its whole life, so there is no later moment at which the loser could
 * win it. Web Locks queues the next waiter when the holder goes away, which is
 * how a *different* invocation of this function — the takeover tab — becomes the
 * leader on the next render.
 */
async function startLeader(
  options: BrowserReplicaOptions,
  env: BrowserReplicaEnv,
  view: ReplicaView,
  broadcast: (message: ReplicaChannelMessage) => void,
  wanted: ReadonlySet<string>,
): Promise<LeaderSession> {
  const bridge = createWorkerBridge(options, env);
  let storage: "opfs" | "memory" = "opfs";
  let degraded = false;

  const leader = new ReplicaLeader({
    userId: options.userId,
    workspaceId: options.workspaceId,
    tabId: options.tabId,
    subscription: { subscribe: options.subscribe, unsubscribe: options.unsubscribe },
    readRange: options.readRange,
    worker: bridge,
    broadcast,
    view,
    onDegraded: (reason) => {
      if (!reason) return;
      degraded = true;
      options.onDegraded?.(reason);
    },
    onCleared: options.onCleared,
  });
  bridge.onMessage((message) => {
    if (message.type === "ready") {
      // `ready` is the Worker's answer to `init`; it names the storage that
      // actually opened, which is how a browser that refuses OPFS is reported
      // without a second capability probe.
      storage = message.storage;
      degraded = message.degraded !== null;
      if (message.degraded) options.onDegraded?.(message.degraded);
      return;
    }
    // Everything else drives the state machine: `opened` subscribes, `backfill`
    // reads through the route, `appended` broadcasts and fills its hole.
    leader.handleWorkerMessage(message);
  });
  // The Worker needs its engine before any other request; `ReplicaWorkerHost.
  // enqueue` serializes, so the `open` calls that follow `becomeLeader` are
  // handled after this one.
  bridge.postMessage({
    type: "init",
    userId: options.userId,
    workspaceId: options.workspaceId,
    // The Worker checks the capability itself as well; this only records the
    // intent, so a forced `memory` in a test is honoured.
    storage: env.hasOpfs === false ? "memory" : "opfs",
  });
  void wanted;
  return { leader, bridge, storage, degraded };
}

interface WorkerBridge {
  postMessage(message: ReplicaWorkerRequest): void;
  onMessage(listener: (message: ReplicaWorkerResponse) => void): () => void;
  terminate?: () => void;
}

/**
 * Wire the real Worker, or a same-thread engine when the environment has none.
 *
 * The same-thread bridge keeps the page-side state machine (refcounts, backfill
 * loop, handoff) testable without a browser, and is never used when a Worker
 * exists: the plan's whole reason for the Worker is that `opfs-sahpool`'s
 * synchronous handles must not run on the page's thread.
 */
function createWorkerBridge(options: BrowserReplicaOptions, env: BrowserReplicaEnv): WorkerBridge {
  const listeners = new Set<(message: ReplicaWorkerResponse) => void>();
  const worker = env.createWorker?.();
  if (worker) {
    worker.addEventListener("message", (event: MessageEvent) => {
      for (const listener of [...listeners]) listener(event.data as ReplicaWorkerResponse);
    });
    return {
      postMessage: (message) => worker.postMessage(message),
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      terminate: () => worker.terminate(),
    };
  }

  const engine = new ReplicaEngine(new MemoryReplicaStorage());
  return {
    postMessage: (message) => {
      for (const response of handleInline(engine, options, message)) {
        for (const listener of [...listeners]) listener({ ...response, token: message.token });
      }
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The same-thread bridge: the requests a leader sends, answered from one engine.
 *
 * Kept identical in behaviour to `ReplicaWorkerHost.handle` for the requests the
 * leader issues; the difference is that this runs on the page and cannot use
 * OPFS, which is why it exists only for the no-Worker case.
 */
function handleInline(
  engine: ReplicaEngine,
  options: BrowserReplicaOptions,
  request: ReplicaWorkerRequest,
): ReplicaWorkerResponse[] {
  switch (request.type) {
    case "init":
      return [{ type: "ready", storage: "memory", degraded: null }];
    case "open": {
      const opened = engine.openSession({
        sessionId: request.sessionId,
        userId: options.userId,
        workspaceId: options.workspaceId,
      });
      const snapshot = engine.snapshot(request.sessionId);
      return [
        {
          type: "opened",
          sessionId: request.sessionId,
          fromSeq: opened.fromSeq,
          head: snapshot.head,
          fresh: snapshot.fresh,
          cleared: opened.cleared?.reason ?? null,
          entries: [...snapshot.entries],
        },
      ];
    }
    case "ack":
      return [{ type: "backfill", sessionId: request.sessionId, range: engine.ack(request.sessionId, request.ack) }];
    case "frames": {
      const missing = engine.frames(request.sessionId, request.frames);
      const snapshot = engine.snapshot(request.sessionId);
      return [
        {
          type: "appended",
          sessionId: request.sessionId,
          range: rangeOfFrames(request.frames),
          head: snapshot.head,
          fresh: snapshot.fresh,
          missing,
          entries: [...snapshot.entries],
        },
      ];
    }
    case "writeWindow": {
      engine.writeWindow(request.sessionId, request.entries, request.range);
      const snapshot = engine.snapshot(request.sessionId);
      return [
        {
          type: "appended",
          sessionId: request.sessionId,
          range: request.range,
          head: snapshot.head,
          fresh: snapshot.fresh,
          missing: null,
          entries: [...snapshot.entries],
        },
      ];
    }
    case "window":
    case "snapshot": {
      const view = engine.snapshot(request.sessionId);
      return [
        {
          type: "windowResult",
          sessionId: request.sessionId,
          entries: request.type === "window" ? engine.readWindow(request.sessionId, request.from, request.to) : [...view.entries],
          head: view.head,
          fresh: view.fresh,
          ready: view.ready,
        },
      ];
    }
    case "readHeight":
      return [
        {
          type: "height",
          sessionId: request.sessionId,
          seq: request.seq,
          key: request.key,
          height: engine.readRowHeight(request.sessionId, request.seq, request.key),
        },
      ];
    case "writeHeight":
      engine.writeRowHeight(request.sessionId, request.seq, request.key, request.height);
      return [];
    case "clear": {
      // The Worker host reports a clear through `Engine.onClear`; this bridge has
      // no such callback wired, so it answers here instead.
      const clears: ReplicaWorkerResponse[] = [];
      engine.onClear = (reason) => clears.push({ type: "cleared", reason });
      engine.clear(request.reason);
      engine.onClear = undefined;
      return clears;
    }
  }
}
