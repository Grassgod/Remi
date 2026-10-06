/**
 * The browser WebSocket's v2 stream frames (MUL-438 / C3; plan 2/6 §2).
 *
 * This module is the socket end of the Live Hub: it owns the per-connection
 * subscription bookkeeping, the payload validation, the authorization call and
 * the four `stream.*` server frames. The hub itself (ring buffer, replay, gap
 * arithmetic) is C1's MUL-436. Real sockets use its backpressure-aware sink;
 * the C0 listener spelling remains available for empty hubs and test doubles.
 *
 * ## Layout
 *
 * - `stream.ack` answers every accepted `stream.subscribe`, carrying the hub's
 *   `first_seq`/`head_seq`/`log_version` and — when the requested `from_seq` is
 *   older than the retained tail — the `gap` the client must backfill through the
 *   read routes. The client is told what it missed; the hub never reads a table
 *   to fill a hole (C0's contract).
 * - `stream.data` carries one ordered batch per subscribed stream.
 * - `stream.gap` is the *mid-stream* signal: the connection fell behind while
 *   subscribed. C1's slow-subscriber path calls {@link sendStreamGap}; it is not
 *   a second spelling of the ack's `gap`.
 * - `stream.error` refuses. Its four codes are frozen in the C0 contract; a
 *   missing id and a forbidden one both answer `forbidden`, so a socket cannot
 *   enumerate sessions or tasks through the error channel.
 *
 * ## One endpoint, one stream kind
 *
 * `/ws` carries `log:*` and `/api/trace/ws` carries `trace:*`. The trace stream
 * lives in the runtime process (ADR 0007 decision 1), so a browser trace socket
 * that lands on the ui process must be told to go elsewhere rather than silently
 * receive nothing: a subscribe for the wrong kind answers
 * `stream.error{code:"wrong_endpoint"}`, which is exactly the `wrong_endpoint`
 * acceptance case.
 */

import type { HubFrame, HubStreamKey, HubStreamName, HubSubscription, LiveHub } from "./live-hub.js";
import type { HubImpl, HubSinkSubscription, HubSubscriberSink } from "./hub-core.js";
import { hubLogStreamKey, hubTraceStreamKey } from "@multiremi/contracts/live-hub.js";
import type { MultiremiWebSocketClient } from "../helpers/realtime-types.js";
import {
  decideLogSubscription,
  decideTraceSubscription,
  type StreamAuthReader,
} from "./stream-auth.js";

/** Which stream kind an endpoint serves. */
export type BrowserStreamEndpoint = HubStreamName;

export interface BrowserStreamHandlerDeps {
  hub: LiveHub & Partial<Pick<HubImpl, "subscribeWithSink">>;
  auth: StreamAuthReader;
  /** The kind this socket accepts; the other one answers `wrong_endpoint`. */
  endpoint: BrowserStreamEndpoint;
  projectLogFrames?: (client: MultiremiWebSocketClient, sessionId: string, frames: readonly HubFrame[]) => Promise<HubFrame[]>;
}

interface ActiveStreamSubscription {
  stream: HubStreamName;
  id: string;
  unsubscribe: () => void;
  notifyDrain: () => void;
}

export interface BrowserStreamHandler {
  /** Handle one client frame. Never throws on bad input — it answers instead. */
  handleSubscribe(client: MultiremiWebSocketClient, event: Record<string, unknown>): Promise<void>;
  handleUnsubscribe(client: MultiremiWebSocketClient, event: Record<string, unknown>): void;
  /** Drop every subscription this connection holds. Called from `close`. */
  disposeClient(client: MultiremiWebSocketClient): void;
  /** Resume this socket's paused streams after the transport has drained. */
  notifyDrain(client: MultiremiWebSocketClient): void;
  /** How many streams this connection currently holds; for tests and logs. */
  subscriptionCount(client: MultiremiWebSocketClient): number;
}

interface ParsedSubscribe {
  stream: HubStreamName;
  id: string;
  fromSeq: number;
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  const payload = event.payload;
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseSubscribe(event: Record<string, unknown>): ParsedSubscribe | null {
  const payload = payloadOf(event);
  const stream = cleanString(payload.stream);
  const id = cleanString(payload.id);
  if ((stream !== "log" && stream !== "trace") || !id) return null;
  const rawFrom = payload.from_seq;
  // `from_seq` is the next sequence the client wants (C0's contract) and is
  // always a plain non-negative integer; a client that sends a float, a string
  // or a negative number gets `invalid_payload` rather than a random replay
  // start.
  if (typeof rawFrom !== "number" || !Number.isSafeInteger(rawFrom) || rawFrom < 0) return null;
  return { stream, id, fromSeq: rawFrom };
}

function parseUnsubscribe(event: Record<string, unknown>): { stream: HubStreamName; id: string } | null {
  const payload = payloadOf(event);
  const stream = cleanString(payload.stream);
  const id = cleanString(payload.id);
  if ((stream !== "log" && stream !== "trace") || !id) return null;
  return { stream, id };
}

function streamKey(stream: HubStreamName, id: string): HubStreamKey {
  return stream === "log" ? hubLogStreamKey(id) : hubTraceStreamKey(id);
}

function subscriptionKey(stream: HubStreamName, id: string): string {
  return stream === "log" ? `log:${id}` : `trace:${id}`;
}

function sendFrame(client: MultiremiWebSocketClient, type: string, payload: unknown): void {
  client.sendText(JSON.stringify({ type, payload }));
}

/**
 * Build the handler for one server process.
 *
 * The subscription set is per client and lives in this closure, not on
 * `client.data`: the browser WS data shape is shared with the v1 scope path and
 * with every existing test double, and the register/unregister calls it drives
 * are already keyed by the socket object.
 */
export function createBrowserStreamHandler(deps: BrowserStreamHandlerDeps): BrowserStreamHandler {
  const byClient = new WeakMap<MultiremiWebSocketClient, Map<string, ActiveStreamSubscription>>();
  const pendingByClient = new WeakMap<MultiremiWebSocketClient, Map<string, symbol>>();
  const disposedClients = new WeakSet<MultiremiWebSocketClient>();

  const subscriptionsOf = (client: MultiremiWebSocketClient): Map<string, ActiveStreamSubscription> => {
    let map = byClient.get(client);
    if (!map) {
      map = new Map();
      byClient.set(client, map);
    }
    return map;
  };

  const sendError = (client: MultiremiWebSocketClient, stream: HubStreamName, id: string, code: string): void => {
    sendFrame(client, "stream.error", { stream, id, code });
  };

  const authorize = async (
    client: MultiremiWebSocketClient,
    stream: HubStreamName,
    id: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> => {
    if (client.data.kind !== "browser" || !client.data.authenticated) {
      return { ok: false, code: "forbidden" };
    }
    const subject = { userId: client.data.userId, workspaceId: client.data.workspaceId };
    if (stream === "log") {
      const facts = await deps.auth.logFacts(id, subject);
      if (!facts.ok) return { ok: false, code: facts.code };
      return decideLogSubscription(subject, facts.facts);
    }
    const facts = await deps.auth.traceFacts(id, subject);
    if (!facts.ok) return { ok: false, code: facts.code };
    return decideTraceSubscription(subject, facts.facts);
  };

  return {
    async handleSubscribe(client, event) {
      if (disposedClients.has(client)) return;
      const parsed = parseSubscribe(event);
      if (!parsed) {
        const payload = payloadOf(event);
        const stream = cleanString(payload.stream);
        sendError(
          client,
          stream === "trace" ? "trace" : "log",
          cleanString(payload.id),
          "invalid_payload",
        );
        return;
      }
      if (parsed.stream !== deps.endpoint) {
        sendError(client, parsed.stream, parsed.id, "wrong_endpoint");
        return;
      }
      const key = subscriptionKey(parsed.stream, parsed.id);
      let pending = pendingByClient.get(client);
      if (!pending) {
        pending = new Map();
        pendingByClient.set(client, pending);
      }
      // Only this request may register after the await. Replacement, unsubscribe
      // and disposal invalidate its identity even before an active handle exists.
      const request = Symbol(key);
      pending.set(key, request);
      let authorized: { ok: true } | { ok: false; code: string };
      try {
        authorized = await authorize(client, parsed.stream, parsed.id);
      } catch {
        // The reader is the only async step and reports its own failures as
        // `unavailable`; anything that escapes it is still a refusal. "Never
        // throws on bad input" has to hold for surprises in a dependency too,
        // because this runs inside the socket's message handler.
        authorized = { ok: false, code: "unavailable" };
      }
      if (disposedClients.has(client) || pending.get(key) !== request) return;
      pending.delete(key);
      if (!authorized.ok) {
        sendError(client, parsed.stream, parsed.id, authorized.code);
        return;
      }

      // One stream, one subscription: a repeat `stream.subscribe` for a stream
      // this socket already holds replaces it — that is the reassign case, and
      // the client uses it to resume a stream from a new `from_seq`.
      const active = subscriptionsOf(client);
      active.get(key)?.unsubscribe();

      // Ordering: the ack is what tells the client which sequences the hub can
      // serve (and where the gap is), so a replay batch handed back during
      // `subscribe` is held and flushed right after it. A hub that never calls
      // the listener during `subscribe` — C0's empty one — leaves the buffer
      // empty and takes the same path.
      let ackSent = false;
      let alive = true;
      let delivery = Promise.resolve();
      let projectionBytes = 0;
      const buffered: Array<() => void> = [];
      const emit = (deliver: () => void | Promise<void>) => {
        if (!alive) return;
        const ordered = () => {
          if (parsed.stream !== "log" || !deps.projectLogFrames) { void deliver(); return; }
          delivery = delivery.then(async () => { if (alive) await deliver(); }).catch(() => {
            if (!alive) return;
            active.get(key)?.unsubscribe();
            active.delete(key);
            sendError(client, parsed.stream, parsed.id, "unavailable");
          });
        };
        if (ackSent) ordered();
        else buffered.push(ordered);
      };
      const sink: HubSubscriberSink = {
        getBufferedAmount: () => (client.getBufferedAmount?.() ?? 0) + projectionBytes,
        send: (batch) => {
          if (batch.length === 0) return;
          const bytes = parsed.stream === "log" && deps.projectLogFrames ? new TextEncoder().encode(JSON.stringify(batch)).byteLength : 0;
          projectionBytes += bytes;
          emit(async () => {
            try {
              const frames = parsed.stream === "log" && deps.projectLogFrames
                ? await deps.projectLogFrames(client, parsed.id, batch) : batch;
              if (alive && frames.length) sendFrame(client, "stream.data", { stream: parsed.stream, id: parsed.id, frames });
            } finally {
              projectionBytes -= bytes;
              // A queued read counts as backpressure until its frames reach the socket.
              if (bytes && alive) subscription.notifyDrain?.();
            }
          });
        },
        gap: (from, to) => emit(() => sendStreamGap(client, parsed.stream, parsed.id, from, to)),
        closed: (head) => emit(() => sendFrame(client, "stream.closed", {
          stream: parsed.stream, id: parsed.id, head_seq: head,
        })),
      };
      let subscription: HubSubscription & Partial<Pick<HubSinkSubscription, "notifyDrain">>;
      try {
        const hubKey = streamKey(parsed.stream, parsed.id);
        subscription = deps.hub.subscribeWithSink
          ? deps.hub.subscribeWithSink(hubKey, parsed.fromSeq, sink)
          : deps.hub.subscribe(hubKey, parsed.fromSeq, (_key, batch) => sink.send(batch));
      } catch {
        // A hub that refuses the key (an unknown kind, a closed hub) is reported
        // to the client rather than thrown at the message handler.
        sendError(client, parsed.stream, parsed.id, "unavailable");
        return;
      }
      active.set(key, {
        stream: parsed.stream,
        id: parsed.id,
        unsubscribe: () => { alive = false; subscription.unsubscribe(); },
        notifyDrain: () => subscription.notifyDrain?.(),
      });
      sendFrame(client, "stream.ack", {
        stream: parsed.stream,
        id: parsed.id,
        first_seq: subscription.first_seq,
        head_seq: subscription.head,
        log_version: subscription.log_version ?? null,
        gap: subscription.gap ?? null,
        ...(parsed.stream === "trace" ? { closed: subscription.closed ?? false } : {}),
      });
      ackSent = true;
      for (const deliver of buffered) { if (alive) deliver(); }
      buffered.length = 0;
    },

    handleUnsubscribe(client, event) {
      const parsed = parseUnsubscribe(event);
      if (!parsed) return;
      const active = subscriptionsOf(client);
      const key = subscriptionKey(parsed.stream, parsed.id);
      pendingByClient.get(client)?.delete(key);
      const subscription = active.get(key);
      if (!subscription) return;
      subscription.unsubscribe();
      active.delete(key);
    },

    disposeClient(client) {
      disposedClients.add(client);
      pendingByClient.get(client)?.clear();
      const active = byClient.get(client);
      if (!active) return;
      for (const subscription of active.values()) subscription.unsubscribe();
      active.clear();
    },

    notifyDrain(client) {
      for (const subscription of byClient.get(client)?.values() ?? []) subscription.notifyDrain();
    },

    subscriptionCount(client) {
      return byClient.get(client)?.size ?? 0;
    },
  };
}

/**
 * The mid-stream gap signal (plan 2/6 §1's slow-subscriber path): the connection
 * fell behind while subscribed and must backfill `[from, to]` through the read
 * routes before the stream can continue.
 *
 * C1 calls this after a drain when its cursor no longer reaches the ring tail.
 */
export function sendStreamGap(
  client: MultiremiWebSocketClient,
  stream: HubStreamName,
  id: string,
  from: number,
  to: number,
): void {
  sendFrame(client, "stream.gap", { stream, id, from, to });
}

// ─── resync ─────────────────────────────────────────────────────────────────────────────────────

/** Upper bound of the resync jitter, in milliseconds (plan 2/6 §1). */
export const BROWSER_RESYNC_JITTER_MAX_MS = 2_000;

export interface BroadcastBrowserResyncOptions {
  /** Every browser socket this process holds, by workspace. */
  browserWebSockets: Map<string, Set<MultiremiWebSocketClient>>;
  /**
   * Delay chosen per socket, in milliseconds. Defaults to a uniform draw from
   * `[0, BROWSER_RESYNC_JITTER_MAX_MS]`; injected by tests so a broadcast is
   * deterministic and immediate.
   */
  jitterMs?: () => number;
  /** Timers, injected by tests. Defaults to `setTimeout` / `clearTimeout`. */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface BrowserResyncHandle {
  /** Sockets the broadcast reached, counted at schedule time. */
  recipients: number;
  /** Cancels every pending frame; the sockets that already got one keep it. */
  cancel(): void;
}

/**
 * Tell every browser connection this process holds to re-subscribe its streams
 * and re-run its reconnect work.
 *
 * The peer adapter calls this after the cross-process link recovers (ADR 0007:
 * "peer 断连的表现是晚到，恢复后对账一次"), so the whole fleet learns about the
 * same recovery at once. The 0–2 s jitter is the storm control: without it every
 * tab in every browser would fire its refetch on the same tick.
 *
 * Returns a handle rather than a promise so a caller can cancel the pending
 * fan-out (server shutdown) and so a test can assert the recipient count without
 * waiting for the jitter.
 */
export function broadcastBrowserResync(options: BroadcastBrowserResyncOptions): BrowserResyncHandle {
  const jitter = options.jitterMs ?? (() => Math.floor(Math.random() * (BROWSER_RESYNC_JITTER_MAX_MS + 1)));
  const schedule = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const frame = JSON.stringify({ type: "resync" });
  const timers: unknown[] = [];
  let recipients = 0;

  for (const clients of options.browserWebSockets.values()) {
    for (const client of [...clients]) {
      if (client.data.kind !== "browser" || !client.data.authenticated) continue;
      recipients += 1;
      const delayMs = Math.max(0, Math.min(BROWSER_RESYNC_JITTER_MAX_MS, Math.trunc(jitter())));
      timers.push(schedule(() => {
        try {
          client.sendText(frame);
        } catch {
          // A socket that died between scheduling and delivery: dropping it here
          // is what the registry's own sweep would do on the next send.
        }
      }, delayMs));
    }
  }

  return {
    recipients,
    cancel: () => {
      for (const timer of timers.splice(0)) cancelTimer(timer);
    },
  };
}
