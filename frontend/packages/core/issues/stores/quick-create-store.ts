"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createWorkspaceAwareStorage, registerForWorkspaceRehydration } from "../../platform/workspace-storage";
import { defaultStorage } from "../../platform/storage";

export type QuickCreateActorType = "agent" | "squad";

// Per-workspace memory of the last actor (agent or squad) the user picked in
// the Quick Create modal. Project is intentionally not persisted: no project
// means the creator agent should inspect the workspace and choose one, while a
// project is only seeded from explicit context (for example, a project page).
// Persisted with the workspace-aware StateStorage so switching workspaces
// shows the right actor automatically. Per-user scoping comes for free from
// localStorage being browser-profile-local — matches how draft-store /
// issues-scope-store already namespace themselves.
//
// lastActorType + lastActorId replace the prior `lastAgentId` field once
// squads became selectable. Users who had a persisted agent preference
// land back on whatever the picker shows first; a one-time re-pick is
// preferable to the type-tag ambiguity of overloading a single UUID.
interface QuickCreateState {
  lastActorType: QuickCreateActorType | null;
  lastActorId: string | null;
  setLastActor: (type: QuickCreateActorType | null, id: string | null) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  clearPrompt: () => void;
  keepOpen: boolean;
  setKeepOpen: (v: boolean) => void;
}

export const useQuickCreateStore = create<QuickCreateState>()(
  persist(
    (set) => ({
      lastActorType: null,
      lastActorId: null,
      setLastActor: (type, id) => set({ lastActorType: type, lastActorId: id }),
      prompt: "",
      setPrompt: (prompt) => set({ prompt }),
      clearPrompt: () => set({ prompt: "" }),
      keepOpen: false,
      setKeepOpen: (v) => set({ keepOpen: v }),
    }),
    {
      name: "multimira_quick_create",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
    },
  ),
);

registerForWorkspaceRehydration(() => useQuickCreateStore.persist.rehydrate());
