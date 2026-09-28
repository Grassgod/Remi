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
const logCounts = new Map<string, { count: number; dispose: () => void }>();
const traceCounts = new Map<string, { count: number; dispose: () => void }>();

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
    const existing = logCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const subscription = subscribeStream("log", sessionId, {
        onAck: (payload) => handlersRef.current.onAck?.(payload),
        onFrames: (frames) => handlersRef.current.onFrames?.(frames),
        onGap: (payload) => handlersRef.current.onGap?.(payload),
        onError: (payload) => handlersRef.current.onError?.(payload),
      });
      // `null` when the socket is not up yet; the provider re-creates its context
      // when it is, which re-runs this effect.
      if (!subscription) return;
      logCounts.set(key, { count: 1, dispose: () => subscription.unsubscribe() });
    }
    return () => {
      const entry = logCounts.get(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      logCounts.delete(key);
      entry.dispose();
    };
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
    const existing = traceCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const subscription: StreamSubscription | null = subscribeTrace(taskId, {
        onAck: (payload) => handlersRef.current.onAck?.(payload),
        onFrames: (frames) => handlersRef.current.onFrames?.(frames),
        onGap: (payload) => handlersRef.current.onGap?.(payload),
        onError: (payload) => handlersRef.current.onError?.(payload),
      });
      if (!subscription) return;
      traceCounts.set(key, { count: 1, dispose: () => subscription.unsubscribe() });
    }
    return () => {
      const entry = traceCounts.get(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      traceCounts.delete(key);
      entry.dispose();
    };
  }, [taskId, enabled, subscribeTrace]);
}

/** Test-only: drop the module-level refcounts between cases. */
export function resetStreamSubscriptionCountsForTesting(): void {
  for (const entry of logCounts.values()) entry.dispose();
  for (const entry of traceCounts.values()) entry.dispose();
  logCounts.clear();
  traceCounts.clear();
}
