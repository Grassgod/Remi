/**
 * Realtime fanout (MUL-462, MUL-455 §1.4).
 *
 * The store raises four in-process events (`onTaskEnqueued`, `onTaskEvent`,
 * `onTaskMessages`, `onWorkspaceEvent`). Before the API could be split into a
 * browser-facing and a daemon-facing process, `server.ts` subscribed to all four
 * inline and delivered straight to the two WebSocket registries it owned.
 *
 * Once there are two processes that stops working: the process that writes an
 * event is not necessarily the one holding the WebSocket. This module is that
 * wiring, named and testable. It subscribes to the store once and does two
 * things per event:
 *
 *   - deliver locally, by role — `ui`/`all` to the browser registries,
 *     `runtime`/`all` to the daemon registry;
 *   - hand the raw event to the peer channel, which forwards it to the other
 *     process (see `peer/peer-channel.ts`).
 *
 * Events that arrive *from* the peer take the local-delivery path only and are
 * never forwarded again — that is what stops two processes echoing one event.
 * A peer-delivered `task_enqueued` still calls `notifyDaemonTaskAvailable`, which
 * is what lets the daemon-facing process wake a runtime for a task created in
 * the browser-facing one.
 *
 * `MULTIREMI_PEER_URL` unset means `peer` is null: local delivery only, and no
 * envelope is even built — exactly the pre-split behaviour.
 */
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiTask, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import {
  PEER_EVENT_PROTOCOL_VERSION,
  type PeerEventEnvelope,
  type PeerEventEnvelopeOf,
  type PeerEventKind,
  type PeerEventPayload,
  type PeerWorkspaceEvent,
} from "@multiremi/contracts/peer-events.js";
import type {
  BrowserScopeWebSocketRegistry,
  BrowserUserWebSocketRegistry,
  BrowserWebSocketRegistry,
  DaemonWebSocketRegistry,
} from "./helpers/realtime-types.js";
import {
  notifyBrowserTaskEvent,
  notifyBrowserTaskMessages,
  notifyBrowserWorkspaceEvent,
  notifyDaemonTaskAvailable,
  notifyDaemonTaskEvent,
} from "./realtime.js";
import {
  PEER_REALTIME_TOPIC,
  type PeerChannel,
} from "./peer/peer-channel.js";

/**
 * Which registries this process holds.
 *
 * MUL-461 (S10-A) owns `config/api-role.ts` and its env-driven `resolveApiRole()`.
 * Until that lands this file declares the union locally and `server.ts` passes
 * `"all"`, which is today's single-process behaviour. After S10-A merges, swap
 * this for `import { type ApiRole } from "../config/api-role.js"`.
 */
export type LocalRealtimeRole = "all" | "ui" | "runtime";

export interface RealtimeFanoutRegistries {
  daemon: DaemonWebSocketRegistry;
  browser: BrowserWebSocketRegistry;
  browserUser: BrowserUserWebSocketRegistry;
  browserScope: BrowserScopeWebSocketRegistry;
}

export interface RealtimeFanoutOptions {
  role: LocalRealtimeRole;
  store: MultiremiStore;
  registries: RealtimeFanoutRegistries;
  /** Absent/null means "no peer": local delivery only, nothing is forwarded. */
  peer?: PeerChannel | null;
}

export interface RealtimeFanout {
  /** Close the store subscriptions and the peer channel. Idempotent. */
  close(): void;
  /** Deliver one envelope that arrived from the peer. Never re-forwards. */
  deliverRemote(envelope: PeerEventEnvelope): void;
  /** Queue one locally produced envelope for the peer. No local delivery. */
  forwardToPeer<K extends PeerEventKind>(kind: K, payload: PeerEventPayload[K]): void;
}

export function createRealtimeFanout(options: RealtimeFanoutOptions): RealtimeFanout {
  const { role, store, registries } = options;
  const peer = options.peer ?? null;

  const deliversToBrowser = role === "ui" || role === "all";
  const deliversToDaemon = role === "runtime" || role === "all";

  // Local delivery only. `forward` is the switch that separates "this process
  // wrote it" from "the peer wrote it"; there is no third case.
  const deliverTaskEnqueued = (task: MultiremiTask): void => {
    if (deliversToDaemon) notifyDaemonTaskAvailable(registries.daemon, store, task);
    if (deliversToBrowser) {
      notifyBrowserTaskEvent(registries.browser, registries.browserScope, "task:queued", task);
    }
  };

  const deliverTaskEvent = (event: { type: string; task: MultiremiTask }): void => {
    if (deliversToDaemon && event.type === "task:waiting_local_directory") {
      notifyDaemonTaskEvent(registries.daemon, event.type, event.task);
    }
    if (deliversToBrowser) {
      notifyBrowserTaskEvent(registries.browser, registries.browserScope, event.type, event.task);
    }
  };

  const deliverTaskMessages = (event: { task: MultiremiTask; messages: MultiremiTaskMessage[] }): void => {
    if (!deliversToBrowser) return;
    notifyBrowserTaskMessages(
      store,
      registries.browser,
      registries.browserScope,
      event.task,
      event.messages,
    );
  };

  const deliverWorkspaceEvent = (event: PeerWorkspaceEvent): void => {
    if (!deliversToBrowser) return;
    notifyBrowserWorkspaceEvent(
      registries.browser,
      registries.browserUser,
      registries.browserScope,
      event,
    );
  };

  function forwardToPeer<K extends PeerEventKind>(kind: K, payload: PeerEventPayload[K]): void {
    if (!peer?.enabled) return;
    const envelope: PeerEventEnvelopeOf<K> = {
      v: PEER_EVENT_PROTOCOL_VERSION,
      origin: peer.origin,
      kind,
      payload,
    };
    peer.publish(PEER_REALTIME_TOPIC, envelope);
  }

  function deliverRemote(envelope: PeerEventEnvelope): void {
    switch (envelope.kind) {
      case "task_enqueued":
        deliverTaskEnqueued(envelope.payload.task);
        return;
      case "task_event":
        deliverTaskEvent(envelope.payload);
        return;
      case "task_messages":
        deliverTaskMessages(envelope.payload);
        return;
      case "workspace_event":
        deliverWorkspaceEvent(envelope.payload.event);
        return;
      default:
        return;
    }
  }

  // Upstream: store event -> local registries (by role) + peer send queue.
  const unsubscribeEnqueued = store.onTaskEnqueued((task) => {
    deliverTaskEnqueued(task);
    forwardToPeer("task_enqueued", { task });
  });
  const unsubscribeTaskEvent = store.onTaskEvent((event) => {
    deliverTaskEvent(event);
    forwardToPeer("task_event", { type: event.type, task: event.task });
  });
  const unsubscribeTaskMessages = store.onTaskMessages((event) => {
    deliverTaskMessages(event);
    forwardToPeer("task_messages", { task: event.task, messages: event.messages });
  });
  const unsubscribeWorkspaceEvent = store.onWorkspaceEvent((event) => {
    deliverWorkspaceEvent(event);
    forwardToPeer("workspace_event", { event });
  });

  // Downstream: peer -> local registries only; nothing on this path forwards.
  const subscription = peer?.subscribe(PEER_REALTIME_TOPIC, (payload) => {
    if (typeof payload !== "object" || payload === null) return;
    deliverRemote(payload as PeerEventEnvelope);
  }) ?? null;

  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribeEnqueued();
      unsubscribeTaskEvent();
      unsubscribeTaskMessages();
      unsubscribeWorkspaceEvent();
      subscription?.unsubscribe();
      peer?.close();
    },
    deliverRemote,
    forwardToPeer,
  };
}
