"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

// Expand state for the usage cost-diagnostics strip.
//
// The two things that strip explains are both long-lived by construction: a
// model with no published rate stays unpriced until someone fills in a custom
// one, and pre-0.2.49 total-only history can never gain an input/output split
// because the daemons that produced it never reported one. Rendered as two
// always-open banners they permanently owned the top of the usage dashboard
// and pushed the KPI tiles under the fold (MUL-168).
//
// So the strip collapses to a single summary line that still names both
// reasons, and this store remembers whether the user opened it — persisted,
// because "I read that already" should survive a refresh. Global rather than
// workspace-scoped, matching the custom-pricing store: the reasons are about
// the pricing table and the historical data format, not about one workspace.
export interface UsageDiagnosticsState {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}

// StorageAdapter (sync getItem returning string | null) is a structural subset
// of zustand's StateStorage, so it can be handed in directly via cast.
const stateStorage = defaultStorage as unknown as StateStorage;

export const useUsageDiagnosticsStore = create<UsageDiagnosticsState>()(
  persist(
    (set) => ({
      expanded: false,
      setExpanded: (expanded) => set({ expanded }),
    }),
    {
      name: "multimira_usage_diagnostics",
      storage: createJSONStorage(() => stateStorage),
    },
  ),
);
