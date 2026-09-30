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
 *   - deliver locally, by role — `ui`/`all` to the browser registries;
 *   - hand the raw event to the peer channel, which forwards it to the other
 *     process (see `peer/peer-channel.ts`).
 *
 * Events that arrive *from* the peer take the local-delivery path only and are
 * never forwarded again — that is what stops two processes echoing one event.
 * Daemon v2 owns its socket separately; A-2 removed the v1 wake-up registry.
 *
 * `MULTIREMI_PEER_URL` unset means `peer` is null: local delivery only, and no
 * envelope is even built — exactly the pre-split behaviour.
 *
 * A peer event may arrive degraded (the sender dropped the task body because it
 * did not fit one POST). Those carry a task id instead, and this process shares
 * the sender's database, so it re-reads the row and builds the same frame. A
 * Header-degraded `task_messages` keeps its message; persisted seq references
 * instead page through current committed rows. Only browser frames consume the
 * messages, and references need not preserve overwritten intermediate versions.
 */
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { TaskMessageFanoutSubject } from "@multiremi/store/context.js";
import type { ApiRole } from "../config/api-role.js";
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
} from "./helpers/realtime-types.js";
import {
  notifyBrowserTaskEvent,
  notifyBrowserTaskMessages,
  notifyBrowserTaskMessageReadFailed,
  notifyBrowserWorkspaceEvent,
} from "./realtime.js";
import {
  PEER_REALTIME_TOPIC,
  type PeerChannel,
} from "./peer/peer-channel.js";

/**
 * Which registries this process holds.
 *
 * The role is the process's one effective role, resolved by `server.ts` from the
 * shared guard (`config/api-role.ts`) — including an injected `apiRole`. This
 * module never reads the role env itself: the fanout must deliver by the same
 * role the routing guard enforces, or a process would refuse traffic for one side
 * while fanning out for the other.
 */
export type LocalRealtimeRole = ApiRole;

export interface RealtimeFanoutRegistries {
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
  /** Receives queued/waiting tasks on runtime/all, from either store or peer. */
  onDaemonTask?: (event: { type: string; task: MultiremiTask }) => void;
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
  // MUL-419: 接 kick
  const onDaemonTask = options.onDaemonTask ?? (() => {});

  const deliversToBrowser = role === "ui" || role === "all";

  // Local delivery only. `forward` is the switch that separates "this process
  // wrote it" from "the peer wrote it"; there is no third case.
  const deliverTaskEnqueued = (task: MultiremiTask): void => {
    if (deliversToBrowser) {
      notifyBrowserTaskEvent(registries.browser, registries.browserScope, "task:queued", task);
    }
  };

  const deliverTaskEvent = (event: { type: string; task: MultiremiTask }): void => {
    if (deliversToBrowser) {
      notifyBrowserTaskEvent(registries.browser, registries.browserScope, event.type, event.task);
    }
  };

  const deliverTaskMessages = (event: { task: TaskMessageFanoutSubject; messages: MultiremiTaskMessage[] }): void => {
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
      { store },
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
        if (!deliversToBrowser) return;
        const task = ("task" in envelope.payload ? envelope.payload.task : null)
          ?? store.getTaskIdentity(envelope.payload.task_id, "fanout");
        if (!task) return;
        if (!("seq_start" in envelope.payload)) {
          deliverTaskMessages({ task, messages: envelope.payload.messages });
          return;
        }
        const pageRows = store.getTaskMessagePageRows();
        let cursor = envelope.payload.seq_start - 1;
        try {
          while (cursor < envelope.payload.seq_end) {
            const messages = store.listTaskMessages(envelope.payload.task_id, cursor, envelope.payload.seq_end, pageRows);
            if (messages.length === 0) break;
            deliverTaskMessages({ task, messages });
            cursor = messages.at(-1)!.seq;
            if (messages.length < pageRows) break;
          }
        } catch {
          peer?.recordReferenceReadFailure();
          console.warn("[realtime-fanout] reference read failed; requesting browser message refetch");
          if (deliversToBrowser) notifyBrowserTaskMessageReadFailed(
            store, registries.browser, registries.browserScope, task,
            { seq_start: envelope.payload.seq_start, seq_end: envelope.payload.seq_end },
          );
        }
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
    const { id, workspaceId, agentId, chatSessionId, issueId, issueSessionId } = event.task;
    forwardToPeer("task_messages", {
      task: { id, workspaceId, agentId, chatSessionId, issueId, issueSessionId },
      task_id: id,
      messages: event.messages,
    });
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
