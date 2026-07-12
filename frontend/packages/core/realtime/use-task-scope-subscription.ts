"use client";

import { useEffect } from "react";
import { useWS } from "./provider";

// Ref-count scope subscriptions per (scope,id) so several open surfaces sharing
// one task don't each tear the subscription down when one closes. Keyed
// globally because the WS connection is a singleton.
const counts = new Map<string, { n: number; dispose: () => void }>();

/**
 * Subscribe the browser to a task's WS scope while `enabled`. Issue tasks are
 * already covered by the workspace-wide broadcast, so this is only load-bearing
 * for chat tasks (server sends those only to task/chat scope subscribers). A
 * subscribe_error (e.g. non-creator of a chat task) is silently ignored — the
 * transcript still works from the one-shot fetch.
 */
export function useTaskScopeSubscription(taskId: string | null | undefined, enabled: boolean): void {
  const { subscribeScope } = useWS();
  useEffect(() => {
    if (!enabled || !taskId) return;
    const key = `task:${taskId}`;
    const existing = counts.get(key);
    if (existing) {
      existing.n += 1;
    } else {
      counts.set(key, { n: 1, dispose: subscribeScope("task", taskId) });
    }
    return () => {
      const entry = counts.get(key);
      if (!entry) return;
      entry.n -= 1;
      if (entry.n <= 0) {
        entry.dispose();
        counts.delete(key);
      }
    };
  }, [taskId, enabled, subscribeScope]);
}
