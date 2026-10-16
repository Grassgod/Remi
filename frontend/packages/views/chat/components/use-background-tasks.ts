"use client";

import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { hashKey, QueryClientContext, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatBackgroundTasksOptions, chatKeys } from "@multiremi/core/chat/queries";
import { getCurrentWsId, subscribeToCurrentSlug } from "@multiremi/core/platform";
import type { ChatBackgroundTask, ChatBackgroundTasksSnapshot } from "@multiremi/core/types";

const EMPTY: readonly ChatBackgroundTask[] = Object.freeze([]);

/** The current workspace id, as the realtime handlers key the cache with it. */
export function useCurrentWsId(): string | null {
  return useSyncExternalStore(subscribeToCurrentSlug, getCurrentWsId, getCurrentWsId);
}

export interface ChatBackgroundTasksView {
  rows: readonly ChatBackgroundTask[];
  /** Running (and paused) tasks, as the registry counts them. */
  running: number;
  /** A read has landed (or a realtime event filled the cache). */
  loaded: boolean;
  error: boolean;
  retry: () => void;
}

/**
 * A Chat's background tasks (PR 6 §8) as the cache holds them, without ever
 * reading them: the launch rows of the steps, the running strip and the
 * panel's switch use this, so they never cause a request (MUL-472). Works
 * outside a query client too (an empty list).
 */
export function useCachedBackgroundTasks(sessionId: string | null | undefined): readonly ChatBackgroundTask[] {
  const qc = useContext(QueryClientContext);
  const wsId = useCurrentWsId();
  const key = useMemo(() => wsId && sessionId ? chatKeys.backgroundTasks(wsId, sessionId) : null, [wsId, sessionId]);
  const hash = key ? hashKey(key) : null;
  const subscribe = useCallback((notify: () => void) => {
    if (!qc || !hash) return () => {};
    return qc.getQueryCache().subscribe((event) => { if (event.query.queryHash === hash) notify(); });
  }, [qc, hash]);
  const read = useCallback(() => key && qc ? qc.getQueryData<ChatBackgroundTasksSnapshot>(key) : undefined, [qc, key]);
  const data = useSyncExternalStore(subscribe, read, read);
  return data?.rows ?? EMPTY;
}

/**
 * A Chat's background tasks from the session registry, read while `enabled`:
 * the visible chat whose session list counts a running task, or the panel
 * showing them.
 *
 * `expectRunning` is that count. While the chat is `visible`, a cached list
 * that disagrees with it is read once more, even when the count dropped to 0
 * and stopped the reading: otherwise a task that ended unseen would stay in
 * the strip as running (PR 6 review #7). Once per disagreement.
 */
export function useChatBackgroundTasks(
  sessionId: string | null | undefined,
  options: { enabled?: boolean; visible?: boolean; expectRunning?: number | null } = {},
): ChatBackgroundTasksView {
  const wsId = useCurrentWsId();
  const qc = useQueryClient();
  const enabled = !!options.enabled && !!wsId && !!sessionId;
  const query = useQuery(chatBackgroundTasksOptions(wsId ?? "", sessionId ?? "", { enabled }));
  const data = query.data;
  const expect = options.expectRunning;
  const cachedRunning = data?.running;
  const visible = options.visible ?? enabled;
  useEffect(() => {
    if (!visible || cachedRunning === undefined || expect == null || expect === cachedRunning || !wsId || !sessionId) return;
    // A disabled query is not refetched by invalidation: fetch it directly, past its staleTime.
    void qc.fetchQuery({ ...chatBackgroundTasksOptions(wsId, sessionId), staleTime: 0 }).catch(() => {});
  }, [visible, expect, cachedRunning, wsId, sessionId, qc]);
  const refetch = query.refetch;
  return useMemo(() => ({
    rows: data?.rows ?? EMPTY,
    running: data?.running ?? 0,
    loaded: !!data,
    error: query.isError,
    retry: () => { void refetch(); },
  }), [data, query.isError, refetch]);
}
