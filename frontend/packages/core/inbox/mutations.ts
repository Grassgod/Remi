import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { inboxKeys } from "./queries";
import { useWorkspaceId } from "../hooks";
import type { InboxItem, InboxPage } from "../types";

interface InboxCacheSnapshot {
  list: InboxItem[] | undefined;
  pages: InfiniteData<InboxPage> | undefined;
}

function snapshotInboxCache(qc: QueryClient, wsId: string): InboxCacheSnapshot {
  return {
    list: qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId)),
    pages: qc.getQueryData<InfiniteData<InboxPage>>(inboxKeys.pages(wsId)),
  };
}

function updateInboxCache(
  qc: QueryClient,
  wsId: string,
  update: (items: InboxItem[]) => InboxItem[],
): void {
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) => old ? update(old) : old);
  qc.setQueryData<InfiniteData<InboxPage>>(inboxKeys.pages(wsId), (old) => old
    ? { ...old, pages: old.pages.map((page) => ({ ...page, items: update(page.items) })) }
    : old);
}

function restoreInboxCache(qc: QueryClient, wsId: string, snapshot?: InboxCacheSnapshot): void {
  if (!snapshot) return;
  qc.setQueryData(inboxKeys.list(wsId), snapshot.list);
  qc.setQueryData(inboxKeys.pages(wsId), snapshot.pages);
}

function invalidateInbox(qc: QueryClient, wsId: string): void {
  void qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) });
}

export function useMarkInboxRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.markInboxRead(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: inboxKeys.all(wsId) });
      const snapshot = snapshotInboxCache(qc, wsId);
      updateInboxCache(qc, wsId, (items) =>
        items.map((item) => (item.id === id ? { ...item, read: true } : item)));
      return snapshot;
    },
    onError: (_err, _id, ctx) => {
      restoreInboxCache(qc, wsId, ctx);
    },
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useArchiveInbox() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.archiveInbox(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: inboxKeys.all(wsId) });
      const snapshot = snapshotInboxCache(qc, wsId);
      updateInboxCache(qc, wsId, (items) =>
        items.map((item) => item.id === id
          ? { ...item, archived: true, read: true }
          : item),
      );
      return snapshot;
    },
    onError: (_err, _id, ctx) => {
      restoreInboxCache(qc, wsId, ctx);
    },
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useArchiveInboxItems() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api.archiveInbox(id))),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: inboxKeys.all(wsId) });
      const snapshot = snapshotInboxCache(qc, wsId);
      const selected = new Set(ids);
      updateInboxCache(qc, wsId, (items) =>
        items.map((item) => selected.has(item.id)
          ? { ...item, archived: true, read: true }
          : item),
      );
      return snapshot;
    },
    onError: (_err, _ids, ctx) => {
      restoreInboxCache(qc, wsId, ctx);
    },
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useMarkAllInboxRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.markAllInboxRead(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: inboxKeys.all(wsId) });
      const snapshot = snapshotInboxCache(qc, wsId);
      updateInboxCache(qc, wsId, (items) =>
        items.map((item) =>
          !item.archived ? { ...item, read: true } : item,
        ),
      );
      return snapshot;
    },
    onError: (_err, _vars, ctx) => {
      restoreInboxCache(qc, wsId, ctx);
    },
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

/** Retries after the first attempt: 1 initial POST + at most 2 retries (MUL-472 d). */
export const MARK_READ_MAX_RETRIES = 2;
/** Minimum wait before a retry, so a failing row cannot spin the mutation loop. */
export const MARK_READ_RETRY_DELAY_MS = 5_000;

/** A 404 means the row is gone; retrying cannot succeed. */
export function isPermanentMarkReadFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export interface MarkInboxReadFailure {
  id: string;
  error: unknown;
  /** Requests actually issued for this id (1..1+MARK_READ_MAX_RETRIES). */
  attempts: number;
  /** False for 404 and for an exhausted retry budget: the id is abandoned. */
  retryable: boolean;
}

export interface MarkInboxItemsReadResult {
  marked: string[];
  failed: MarkInboxReadFailure[];
}

/**
 * Throwable form of a partial failure, so the mutation's `onError` rollback
 * still runs while the caller keeps the per-id detail needed to park the rows.
 */
export class MarkInboxItemsReadError extends Error {
  readonly failed: MarkInboxReadFailure[];
  readonly marked: string[];
  constructor(result: MarkInboxItemsReadResult) {
    // Deliberately id-free: this message reaches a user-facing toast, and the
    // ids are already available on `failed` for callers that need them.
    super("Failed to mark the notification as read");
    this.name = "MarkInboxItemsReadError";
    this.failed = result.failed;
    this.marked = result.marked;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `POST /api/inbox/:id/read` for the rows an automatic selection marked read,
 * with a per-id request budget (MUL-472 d).
 *
 * The old shape was `Promise.all(ids.map(api.markInboxRead))` driven by an
 * effect that re-ran whenever the optimistic write was rolled back, so a
 * persistently failing row looped until the tab closed — MUL-367's baseline
 * caught 992 retries in a single run. Here each id gets one request plus at
 * most `MARK_READ_MAX_RETRIES` retries, each at least
 * `MARK_READ_RETRY_DELAY_MS` later, and a 404 stops immediately.
 */
export async function markInboxItemsReadBounded(
  ids: readonly string[],
  options: { delayMs?: number; onDelay?: (id: string, waitMs: number) => void } = {},
): Promise<MarkInboxItemsReadResult> {
  const delayMs = options.delayMs ?? MARK_READ_RETRY_DELAY_MS;
  const marked: string[] = [];
  const failed: MarkInboxReadFailure[] = [];

  for (const id of ids) {
    let attempts = 0;
    let lastError: unknown = null;
    for (;;) {
      attempts += 1;
      try {
        await api.markInboxRead(id);
        marked.push(id);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (isPermanentMarkReadFailure(error)) break;
        if (attempts > MARK_READ_MAX_RETRIES) break;
        options.onDelay?.(id, delayMs);
        await sleep(delayMs);
      }
    }
    if (lastError !== null) {
      failed.push({
        id,
        error: lastError,
        attempts,
        retryable: !isPermanentMarkReadFailure(lastError),
      });
    }
  }

  return { marked, failed };
}

export function useMarkInboxItemsRead(
  /**
   * Injecting the retry delay is for tests only; production always uses
   * `MARK_READ_RETRY_DELAY_MS` (>= 5 s), which is what the acceptance rule
   * pins down.
   */
  options: { retryDelayMs?: number } = {},
) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const retryDelayMs = options.retryDelayMs;
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const result = await markInboxItemsReadBounded(ids, { delayMs: retryDelayMs });
      if (result.failed.length > 0) throw new MarkInboxItemsReadError(result);
      return result;
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: inboxKeys.all(wsId) });
      const snapshot = snapshotInboxCache(qc, wsId);
      const selected = new Set(ids);
      updateInboxCache(qc, wsId, (items) =>
        items.map((item) => selected.has(item.id) ? { ...item, read: true } : item));
      return snapshot;
    },
    onError: (_err, _ids, ctx) => {
      restoreInboxCache(qc, wsId, ctx);
    },
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useArchiveAllInbox() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.archiveAllInbox(),
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useArchiveAllReadInbox() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.archiveAllReadInbox(),
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}

export function useArchiveCompletedInbox() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.archiveCompletedInbox(),
    onSettled: () => {
      invalidateInbox(qc, wsId);
    },
  });
}
