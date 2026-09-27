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
 *
 * A peer event may arrive degraded (the sender dropped the task body because it
 * did not fit one POST). Those carry a task id instead, and this process shares
 * the sender's database, so it re-reads the row and builds the same frame. A
 * degraded `task_messages` keeps its message and only re-reads the task header,
 * so the browser still sees one frame per message in `seq` order.
 */
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiTask, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import {
  PEER_EVENT_PROTOCOL_VERSION,
  type PeerEventEnvelope,
  type PeerEventKind,
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

/**
 * Where this process's role comes from.
 *
 * One function on purpose: after the role guard lands, this body becomes
 * `return resolveApiRole();` with an import at the top of the file and nothing
 * else moves. Until then there is no role env var, so every process is `all` —
 * exactly what the pre-split server was.
 */
export function resolveLocalRealtimeRole(
  _env: Record<string, string | undefined> = process.env,
): LocalRealtimeRole {
  // TODO(MUL-461): replace with the shared role guard once it merges.
  return "all";
}

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
  /** Queue one locally produced event for the peer. No local delivery. */
  forwardToPeer(kind: PeerEventKind, payload: Record<string, unknown>): void;
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

  function forwardToPeer(kind: PeerEventKind, payload: Record<string, unknown>): void {
    if (!peer?.enabled) return;
    peer.forwardRealtime(kind, payload);
  }

  function deliverRemote(envelope: PeerEventEnvelope): void {
    switch (envelope.kind) {
      case "task_enqueued": {
        const task = resolveRemoteTask(store, envelope.payload);
        if (task) deliverTaskEnqueued(task);
        return;
      }
      case "task_event": {
        const task = resolveRemoteTask(store, envelope.payload);
        if (task) deliverTaskEvent({ type: envelope.payload.type, task });
        return;
      }
      case "task_messages": {
        const task = resolveRemoteTask(store, envelope.payload);
        if (task) deliverTaskMessages({ task, messages: envelope.payload.messages });
        return;
      }
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
    forwardToPeer("task_enqueued", { task, task_id: task.id });
  });
  const unsubscribeTaskEvent = store.onTaskEvent((event) => {
    deliverTaskEvent(event);
    forwardToPeer("task_event", { type: event.type, task: event.task, task_id: event.task.id });
  });
  const unsubscribeTaskMessages = store.onTaskMessages((event) => {
    deliverTaskMessages(event);
    forwardToPeer("task_messages", { task: event.task, task_id: event.task.id, messages: event.messages });
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

/**
 * The task a peer event refers to.
 *
 * The full body is used when the sender could send it; a degraded event only
 * carries the id, and this process reads the shared row instead. A row that is
 * already gone (deleted between the write and the delivery) yields null and the
 * frame is skipped — the browser's next fetch reflects the deletion anyway.
 */
function resolveRemoteTask(
  store: MultiremiStore,
  payload: { task?: MultiremiTask; task_id?: string },
): MultiremiTask | null {
  if (payload.task) return payload.task;
  const taskId = payload.task_id;
  return taskId ? store.getTask(taskId) : null;
}
