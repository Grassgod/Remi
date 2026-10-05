"use client";

import { useEffect, useRef } from "react";
import type { StreamSubscription, StreamSubscriptionHandlers } from "../api/ws-client";
import { useWS } from "./provider";

/**
 * Stream subscription hooks (MUL-438).
 *
 * The v2 streams are ref-counted per `(stream, id)` like the v1 scopes were, and
 * for the same reason: several surfaces can have the same transcript open at once
 * (an issue timeline and its chat popover, a trace panel and a run card), and the
 * first one to unmount must not tear the subscription out from under the others.
 *
 * Keyed globally because the socket is a singleton; a hook that keeps its own
 * handle would fork the subscription per mount.
 */
type Consumer = { current: StreamSubscriptionHandlers };
interface SharedSubscription {
  consumers: Set<Consumer>;
  dispose: () => void;
}
const logCounts = new Map<string, SharedSubscription>();
const traceCounts = new Map<string, SharedSubscription>();

function registerConsumer(
  subscriptions: Map<string, SharedSubscription>,
  key: string,
  consumer: Consumer,
  subscribe: (handlers: StreamSubscriptionHandlers) => StreamSubscription | null,
): (() => void) | undefined {
  let entry = subscriptions.get(key);
  if (entry) {
    entry.consumers.add(consumer);
  } else {
    const consumers = new Set([consumer]);
    const subscription = subscribe({
      onAck: (payload) => { for (const listener of consumers) listener.current.onAck?.(payload); },
      onFrames: (frames) => { for (const listener of consumers) listener.current.onFrames?.(frames); },
      onGap: (payload) => { for (const listener of consumers) listener.current.onGap?.(payload); },
      onError: (payload) => { for (const listener of consumers) listener.current.onError?.(payload); },
      onClosed: (payload) => { for (const listener of consumers) listener.current.onClosed?.(payload); },
    });
    // The provider retries this effect when its socket becomes available.
    if (!subscription) return;
    entry = { consumers, dispose: () => subscription.unsubscribe() };
    subscriptions.set(key, entry);
  }
  const shared = entry;
  return () => {
    shared.consumers.delete(consumer);
    if (shared.consumers.size > 0) return;
    subscriptions.delete(key);
    shared.dispose();
  };
}

/**
 * Subscribe to `log:<sessionId>` while `enabled`.
 *
 * Handlers are read from a ref, so a caller that builds them inline does not
 * re-subscribe on every render — the same treatment the v1 scope hook gives its
 * disposer.
 */
export function useLogStreamSubscription(
  sessionId: string | null | undefined,
  handlers: StreamSubscriptionHandlers,
  enabled = true,
): void {
  const { subscribeStream } = useWS();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const key = `log:${sessionId}`;
    return registerConsumer(logCounts, key, handlersRef, (callbacks) => subscribeStream("log", sessionId, callbacks));
  }, [sessionId, enabled, subscribeStream]);
}

/**
 * Subscribe to `trace:<taskId>` while `enabled`.
 *
 * Unlike the log hook this opens the lazily-created trace socket on its first
 * use, and the socket closes again when the last subscription goes away (the
 * `TraceSocket` owns that rule, so it holds even if a caller bypasses this hook).
 */
export function useTraceStreamSubscription(
  taskId: string | null | undefined,
  handlers: StreamSubscriptionHandlers,
  enabled = true,
): void {
  const { subscribeTrace } = useWS();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !taskId) return;
    const key = `trace:${taskId}`;
    return registerConsumer(traceCounts, key, handlersRef, (callbacks) => subscribeTrace(taskId, callbacks));
  }, [taskId, enabled, subscribeTrace]);
}

/** Test-only: drop the module-level refcounts between cases. */
export function resetStreamSubscriptionCountsForTesting(): void {
  for (const entry of logCounts.values()) entry.dispose();
  for (const entry of traceCounts.values()) entry.dispose();
  logCounts.clear();
  traceCounts.clear();
}
