import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
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

export function useMarkInboxItemsRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api.markInboxRead(id))),
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
