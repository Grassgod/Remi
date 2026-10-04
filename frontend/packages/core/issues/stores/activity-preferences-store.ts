"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { useWorkspaceId } from "../../hooks";
import { defaultStorage } from "../../platform/storage";
import { createWorkspaceAwareStorage } from "../../platform/workspace-storage";
import type { StorageAdapter } from "../../types/storage";

export function createActivityPreferencesStore(userId: string, workspaceId: string, storage: StorageAdapter = defaultStorage) {
  return createStore<{ showSystemDetails: boolean; setShowSystemDetails: (value: boolean) => void }>()(persist(
    set => ({ showSystemDetails: false, setShowSystemDetails: showSystemDetails => set({ showSystemDetails }) }),
    {
      name: `multimira_issue_activity:${userId}`,
      storage: createJSONStorage(() => createWorkspaceAwareStorage(storage, () => userId && workspaceId || null)),
      partialize: state => ({ showSystemDetails: state.showSystemDetails }),
      merge: (saved, state) => ({ ...state, showSystemDetails: (saved as { showSystemDetails?: unknown })?.showSystemDetails === true }),
    },
  ));
}

const stores = new Map<string, ReturnType<typeof createActivityPreferencesStore>>();

export function activityPreferencesStore(userId: string, workspaceId: string) {
  const key = JSON.stringify([userId, workspaceId]);
  // A new identity gets its own synchronously hydrated store. Deferred workspace
  // rehydration would change the filtered rows after the first visible frame.
  let store = stores.get(key);
  if (!store) {
    store = createActivityPreferencesStore(userId, workspaceId);
    stores.set(key, store);
  }
  return store;
}

export function useActivityPreferences(userId = "") {
  const store = activityPreferencesStore(userId, useWorkspaceId());
  const showSystemDetails = useSyncExternalStore(store.subscribe, () => store.getState().showSystemDetails, () => false);
  const ready = useSyncExternalStore(store.subscribe, () => true, () => false);
  return { ready, showSystemDetails, setShowSystemDetails: store.getState().setShowSystemDetails };
}
