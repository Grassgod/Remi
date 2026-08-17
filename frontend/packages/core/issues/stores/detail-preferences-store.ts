"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../../platform/storage";

interface IssueDetailPreferencesState {
  sessionSidebarOpen: boolean;
  setSessionSidebarOpen: (open: boolean) => void;
  toggleSessionSidebar: () => void;
}

export const useIssueDetailPreferencesStore = create<IssueDetailPreferencesState>()(
  persist(
    (set) => ({
      sessionSidebarOpen: true,
      setSessionSidebarOpen: (sessionSidebarOpen) => set({ sessionSidebarOpen }),
      toggleSessionSidebar: () =>
        set((state) => ({ sessionSidebarOpen: !state.sessionSidebarOpen })),
    }),
    {
      name: "multimira_issue_detail_preferences",
      storage: createJSONStorage(() => defaultStorage),
      partialize: (state) => ({ sessionSidebarOpen: state.sessionSidebarOpen }),
    },
  ),
);
