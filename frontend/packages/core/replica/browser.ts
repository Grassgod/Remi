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
import { REPLICA_CHANNEL, replicaLockName, type ReplicaChannelMessage } from "./channel";
import { ReplicaEngine, type ReplicaClearEvent } from "./engine";
import { ReplicaFollower } from "./follower";
import { ReplicaLeader } from "./leader";
import { MemoryReplicaStorage } from "./storage";
import { ReplicaView } from "./view";
import type { SessionLogEntry, SessionReplicaPort } from "./port";
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
  const channel = env.broadcastChannel
    ? new env.broadcastChannel(REPLICA_CHANNEL)
    : typeof BroadcastChannel === "function"
      ? new BroadcastChannel(REPLICA_CHANNEL)
      : null;
  const broadcast = (message: ReplicaChannelMessage) => {
    channel?.postMessage(message);
  };

  // No Web Locks: every tab runs its own replica. The plan's fallback, and the
  // protocol is unchanged — only the sharing is gone.
  if (!hasLocks) {
    options.onDegraded?.("navigator.locks unavailable; running a per-tab memory replica");
    return createMemoryTabsReplica(options, view);
  }

  const follower = new ReplicaFollower({
    view,
    broadcast,
    requestWindow: (input) => broadcast({ type: "replica:query", ...input }),
  });
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as ReplicaChannelMessage;
      // A tab must not act on its own broadcast: the leader would open a session
      // twice and the refcount would never fall back to zero.
      if (message.type === "replica:leader" && message.tabId === options.tabId) return;
      follower.handle(message);
    };
  }

  const elected = await electLeader(options, env, view, broadcast);
  if (elected) return elected;

  return followerReplica(follower, view, channel);
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
async function electLeader(
  options: BrowserReplicaOptions,
  env: BrowserReplicaEnv,
  view: ReplicaView,
  broadcast: (message: ReplicaChannelMessage) => void,
): Promise<BrowserReplica | null> {
  const locks = env.locks ?? (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return null;

  let granted = false;
  const began = new Promise<void>((resolve) => {
    void locks
      .request(replicaLockName(options.userId, options.workspaceId), { mode: "exclusive" }, async () => {
        granted = true;
        resolve();
        await new Promise<never>(() => {});
      })
      .catch(() => resolve());
  });
  // `navigator.locks.request` resolves its grant in a later task even when the
  // lock is free, so the winner is known after exactly that one task.
  await began;
  if (!granted) return null;

  const session = await startLeader(options, env, view, broadcast);
  return leaderReplica(session, view);
}

/** Wire the Worker (or a same-thread bridge) and start the leader loop. */
async function startLeader(
  options: BrowserReplicaOptions,
  env: BrowserReplicaEnv,
  view: ReplicaView,
  broadcast: (message: ReplicaChannelMessage) => void,
): Promise<LeaderSession> {
  const bridge = createWorkerBridge(options, env);
  let storage: "opfs" | "memory" = env.createWorker && (env.hasOpfs ?? true) ? "opfs" : "memory";
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
      storage = message.storage;
      degraded = message.degraded !== null;
      if (message.degraded) options.onDegraded?.(message.degraded);
    }
  });
  // `run()` never settles while the tab lives, so it is not awaited: the leader
  // is holding the lock from the moment its callback ran.
  void leader.run();
  bridge.postMessage({ type: "init", userId: options.userId, workspaceId: options.workspaceId, storage: "opfs" });

  return { leader, bridge, storage, degraded };
}

function leaderReplica(session: LeaderSession, view: ReplicaView): BrowserReplica {
  return {
    port: view,
    open: (sessionId) => session.leader.open(sessionId),
    close: (sessionId) => session.leader.close(sessionId),
    loadWindow: (sessionId, range) => session.leader.loadWindow(sessionId, range),
    frames: (sessionId, frames) => session.leader.frames(sessionId, frames),
    ack: (sessionId, ack) => session.leader.ack(sessionId, ack),
    clear: (reason) => session.leader.clear(reason),
    isLeader: true,
    get storage() {
      return session.storage;
    },
    get degraded() {
      return session.degraded;
    },
    dispose: () => {
      session.leader.dispose();
      session.bridge.terminate?.();
    },
  };
}

function followerReplica(
  follower: ReplicaFollower,
  view: ReplicaView,
  channel: BroadcastChannel | null,
): BrowserReplica {
  return {
    port: follower,
    open: (sessionId) => {
      // A follower's first read is what announces its interest; `getSnapshot`
      // does that so a caller that only opens never races the window query.
      follower.getSnapshot(sessionId);
    },
    close: (sessionId) => follower.close(sessionId),
    loadWindow: async (sessionId, range) => follower.request(sessionId, range),
    frames: () => {
      // A follower leads no subscription; frames arrive at the leader only.
    },
    ack: () => {
      // Same: acks answer the leader's subscribe.
    },
    clear: () => {
      // A follower cannot delete the database; the leader's `replica:cleared`
      // broadcast is what drops every tab's cache.
      view.dropAll();
    },
    isLeader: false,
    storage: null,
    degraded: false,
    dispose: () => channel?.close(),
  };
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
        for (const listener of [...listeners]) listener(response);
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
        },
      ];
    }
    case "ack":
      return [{ type: "backfill", sessionId: request.sessionId, range: engine.ack(request.sessionId, request.ack) }];
    case "frames": {
      const missing = engine.frames(request.sessionId, request.frames);
      const snapshot = engine.snapshot(request.sessionId);
      const seqs = request.frames.map((frame) => frame.seq);
      return [
        {
          type: "appended",
          sessionId: request.sessionId,
          range: seqs.length > 0 ? { from: Math.min(...seqs), to: Math.max(...seqs) } : null,
          head: snapshot.head,
          fresh: snapshot.fresh,
          missing,
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
    case "clear":
      engine.clear(request.reason);
      return [{ type: "cleared", reason: request.reason }];
  }
}
