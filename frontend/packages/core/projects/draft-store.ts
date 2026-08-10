import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createWorkspaceAwareStorage, registerForWorkspaceRehydration } from "../platform/workspace-storage";
import { defaultStorage } from "../platform/storage";

interface ProjectDraft {
  title: string;
  description: string;
  leadType?: "member" | null;
  leadId?: string | null;
  icon?: string;
}

const EMPTY_DRAFT: ProjectDraft = {
  title: "",
  description: "",
  leadType: undefined,
  leadId: undefined,
  icon: undefined,
};

interface ProjectDraftStore {
  draft: ProjectDraft;
  setDraft: (patch: Partial<ProjectDraft>) => void;
  clearDraft: () => void;
  hasDraft: () => boolean;
}

export const useProjectDraftStore = create<ProjectDraftStore>()(
  persist(
    (set, get) => ({
      draft: { ...EMPTY_DRAFT },
      setDraft: (patch) =>
        set((s) => ({ draft: { ...s.draft, ...patch } })),
      clearDraft: () =>
        set({ draft: { ...EMPTY_DRAFT } }),
      hasDraft: () => {
        const { draft } = get();
        return !!(draft.title || draft.description);
      },
    }),
    {
      name: "multimira_project_draft",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
    },
  ),
);

registerForWorkspaceRehydration(() => useProjectDraftStore.persist.rehydrate());
