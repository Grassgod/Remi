"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

// Whether the viewer has dismissed the "historical tokens have totals only"
// banner. Unlike the unmapped-pricing banner next to it, that notice has no
// remedy: daemons before the 2026-08-26 split fix reported context occupancy
// with no input/output dimension, and the missing dimensions were never
// persisted, so no amount of configuration makes those rows priceable. The
// notice is worth showing once — it explains a cost figure that doesn't cover
// every token — but it would otherwise sit on the dashboard forever, so it
// gets an explicit off switch. Stored globally rather than per workspace: the
// user learns the fact once, not once per workspace.
export interface LegacyUsageNoticeState {
  dismissed: boolean;
  dismiss: () => void;
  /** Test / settings escape hatch — nothing in the dashboard UI calls it. */
  reset: () => void;
}

// StorageAdapter (sync getItem returning string | null) is a structural subset
// of zustand's StateStorage, so it can be handed in directly via cast.
const stateStorage = defaultStorage as unknown as StateStorage;

export const useLegacyUsageNoticeStore = create<LegacyUsageNoticeState>()(
  persist(
    (set) => ({
      dismissed: false,
      dismiss: () => set({ dismissed: true }),
      reset: () => set({ dismissed: false }),
    }),
    {
      name: "multimira_dashboard_legacy_usage_notice",
      storage: createJSONStorage(() => stateStorage),
    },
  ),
);
