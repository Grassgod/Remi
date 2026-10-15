"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TraceEvent, TraceItem, TraceTurn } from "@multiremi/contracts/trace";
import {
  applyTurnTraceEvents,
  applyTurnTracePage,
  closeTurnTrace,
  EMPTY_TURN_TRACE,
  type TurnTraceState,
} from "@multiremi/shared/turn-trace";
import { api, parseTraceFrames, type TaskTraceRead } from "@multiremi/core/api";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";

/**
 * One attempt's turn + items trace (PR 2), shared by every reader of the same
 * attempt: Chat's live steps and context ring, a finished turn's fold, the
 * execution dialog.
 *
 * The query key stays `["task-trace", attemptId]`, so the MUL-472 shell guard
 * (`layout/shell-deferred-queries.test.tsx`) still sees it and the chat-done
 * handler still invalidates it. The cache holds the reducer state from
 * `@multiremi/shared/turn-trace`: a read folds every `view=turn` page, and live
 * `trace:` frames apply on top with the same seq rules, so frames that repeat
 * what a page already holds are no-ops. A `stream.gap` refetches the snapshot,
 * which replaces the state.
 */

export const turnTraceKey = (attemptId: string | null | undefined) => ["task-trace", attemptId] as const;

/** What a read reported beyond the page: the trace's availability and format. */
export type TurnTraceReadInfo = Pick<TaskTraceRead,
  "state" | "format" | "reason" | "retryable" | "runtime_id" | "runtime_name" | "last_seen_at">;

/** The cached value under {@link turnTraceKey}. */
export interface TurnTraceCache {
  state: TurnTraceState;
  /** The last read; null until the first read lands (live frames may come first). */
  read: TurnTraceReadInfo | null;
  /** Live events seen while a read was in flight, replayed on top of its pages. */
  pending: readonly TraceEvent[];
}

export const EMPTY_TURN_TRACE_CACHE: TurnTraceCache = Object.freeze({ state: EMPTY_TURN_TRACE, read: null, pending: [] });

/** A fold has to stay readable: pages stop here even if a cursor keeps going. */
const MAX_PAGES = 200;
/** Live events kept for replay while a read is in flight. */
const PENDING_LIMIT = 2000;

export interface TurnTraceView {
  turn: TraceTurn | null;
  /** Every item at any depth, in first-seen order. */
  items: readonly TraceItem[];
  /** The trace is sealed: the page said so, or the stream closed. */
  closed: boolean;
  /** A read has landed. */
  loaded: boolean;
  error: boolean;
  retry: () => void;
  read: TurnTraceReadInfo | null;
  /** The head seq the state reflects. */
  head: number;
}

export interface UseTurnTraceOptions {
  /** Read only while the consumer is visible (MUL-472: no trace on first screen). */
  enabled?: boolean;
  /** Also follow the trace socket while the trace is open. */
  live?: boolean;
  /** The turn whose attempt this is; reads through the turn route. */
  turnId?: string;
}

function isCache(value: unknown): value is TurnTraceCache {
  return !!value && typeof value === "object" && "state" in value && "pending" in value;
}

function cacheOf(qc: QueryClient, attemptId: string): TurnTraceCache {
  const value = qc.getQueryData(turnTraceKey(attemptId));
  return isCache(value) ? value : EMPTY_TURN_TRACE_CACHE;
}

function readInfo(page: TaskTraceRead): TurnTraceReadInfo {
  return {
    state: page.state, format: page.format, reason: page.reason, retryable: page.retryable,
    runtime_id: page.runtime_id, runtime_name: page.runtime_name, last_seen_at: page.last_seen_at,
  };
}

/**
 * Read every page of an attempt's trace and fold it. Stops at the first page
 * that is not `ok`. `onPage` sees the fold after each page that has more after
 * it, so a long trace can show while the rest loads.
 */
export async function readTurnTrace(
  attemptId: string,
  turnId: string | undefined,
  onPage?: (state: TurnTraceState) => void,
): Promise<{ state: TurnTraceState; read: TurnTraceReadInfo }> {
  let state = EMPTY_TURN_TRACE;
  let cursor: number | null = 0;
  let read: TurnTraceReadInfo | null = null;
  for (let pages = 0; cursor !== null && pages < MAX_PAGES; pages++) {
    const page: TaskTraceRead = await api.getTaskTrace(attemptId, { itemCursor: cursor, turnId });
    read = readInfo(page);
    if (page.state !== "ok") return { state: EMPTY_TURN_TRACE, read };
    state = applyTurnTracePage(state, page);
    const next: number | null = page.next_item_cursor;
    if (next !== null && next <= cursor) throw new Error("Trace item cursor did not advance");
    cursor = next;
    if (cursor !== null) onPage?.(state);
  }
  return { state, read: read! };
}

export function useTurnTrace(attemptId: string | null | undefined, options: UseTurnTraceOptions = {}): TurnTraceView {
  const { enabled = true, live = false, turnId } = options;
  const qc = useQueryClient();
  const key = useMemo(() => turnTraceKey(attemptId), [attemptId]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: key,
    enabled: enabled && !!attemptId,
    // A live reader is kept current by the socket; anyone else rereads an
    // unsealed trace when it mounts, so a fold opened after the run never
    // shows a partial snapshot left behind by a live view. A cache that only
    // holds frames (no read has landed) is always stale.
    staleTime: (q) => {
      const cache = isCache(q.state.data) ? q.state.data : null;
      if (!cache?.read) return 0;
      return live || cache.state.closed ? Infinity : 0;
    },
    queryFn: async (): Promise<TurnTraceCache> => {
      if (!attemptId) return EMPTY_TURN_TRACE_CACHE;
      const { state, read } = await readTurnTrace(attemptId, turnId, (partial) => {
        // Show what has loaded so far; the read is not marked landed until the
        // last page, and frames seen meanwhile stay queued for the final fold.
        // A reread (after a gap) keeps showing the state it replaces instead.
        qc.setQueryData<TurnTraceCache>(turnTraceKey(attemptId), (current) => {
          const cache = isCache(current) ? current : EMPTY_TURN_TRACE_CACHE;
          if (cache.read) return cache;
          return { ...cache, state: cache.pending.length ? applyTurnTraceEvents(partial, cache.pending) : partial };
        });
      });
      // Frames that arrived while the pages were in flight go on top, in order;
      // the seq rules make the ones the pages already hold no-ops.
      const current = cacheOf(qc, attemptId);
      let next = current.pending.length ? applyTurnTraceEvents(state, current.pending) : state;
      if (current.state.closed && read.state === "ok") next = closeTurnTrace(next);
      return { state: next, read, pending: [] };
    },
  });
  const data = isCache(query.data) ? query.data : null;
  const state = data?.state ?? EMPTY_TURN_TRACE;

  const update = useCallback((apply: (cache: TurnTraceCache) => TurnTraceCache) => {
    if (!attemptId) return;
    qc.setQueryData<TurnTraceCache>(turnTraceKey(attemptId), (current) => apply(isCache(current) ? current : EMPTY_TURN_TRACE_CACHE));
  }, [attemptId, qc]);

  const streamFailed = streamError !== null && streamError === attemptId;
  // A v1 file never streams turn + items events; there is nothing to follow.
  const subscribed = enabled && live && !!attemptId && !state.closed && !streamFailed && data?.read?.format !== "legacy";
  useTraceStreamSubscription(attemptId, {
    onFrames: (frames) => {
      const events = parseTraceFrames(frames);
      if (!events.length || !attemptId) return;
      const fetching = qc.getQueryState(turnTraceKey(attemptId))?.fetchStatus === "fetching";
      update((cache) => ({
        ...cache,
        state: applyTurnTraceEvents(cache.state, events),
        pending: fetching ? [...cache.pending, ...events].slice(-PENDING_LIMIT) : cache.pending,
      }));
    },
    onAck: (ack) => {
      if (!attemptId) return;
      if (ack.closed && ack.head_seq === 0) update((cache) => ({ ...cache, state: closeTurnTrace(cache.state) }));
      if (!ack.gap) return;
      // The hub no longer holds the start of the trace. A loaded snapshot that
      // already reaches past the gap needs nothing; a read in flight covers it.
      const cache = cacheOf(qc, attemptId);
      const fetching = qc.getQueryState(turnTraceKey(attemptId))?.fetchStatus === "fetching";
      if (!fetching && cache.read && cache.state.head < ack.gap.to) void qc.invalidateQueries({ queryKey: turnTraceKey(attemptId) });
    },
    onGap: () => { if (attemptId) void qc.invalidateQueries({ queryKey: turnTraceKey(attemptId) }); },
    onClosed: () => update((cache) => ({ ...cache, state: closeTurnTrace(cache.state) })),
    onError: () => { if (attemptId) setStreamError(attemptId); },
  }, subscribed, { fromSeq: data?.read ? state.head + 1 : undefined });

  const refetch = query.refetch;
  const retry = useCallback(() => {
    setStreamError(null);
    void refetch();
  }, [refetch]);

  return {
    turn: state.turn,
    items: state.items,
    closed: state.closed,
    loaded: !!data?.read,
    error: query.isError || streamFailed,
    retry,
    read: data?.read ?? null,
    head: state.head,
  };
}
