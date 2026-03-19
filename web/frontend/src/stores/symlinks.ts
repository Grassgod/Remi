import { create } from "zustand";
import type { SymlinkMapping, SymlinksStatus } from "../api/types";
import * as api from "../api/client";

type SymlinkFilter = "all" | "ok" | "broken" | "not_linked";

interface SymlinksState {
  mappings: SymlinkMapping[];
  stats: SymlinksStatus["stats"];
  loading: boolean;
  error: string | null;
  filter: SymlinkFilter;

  fetch: () => Promise<void>;
  fixAll: () => Promise<void>;
  setFilter: (filter: SymlinkFilter) => void;
}

export const useSymlinksStore = create<SymlinksState>((set, get) => ({
  mappings: [],
  stats: { total: 0, ok: 0, broken: 0, notLinked: 0 },
  loading: false,
  error: null,
  filter: "all",

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.getSymlinksStatus();
      set({ mappings: data.mappings, stats: data.stats, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fixAll: async () => {
    set({ loading: true, error: null });
    try {
      await api.fixAllSymlinks();
      await get().fetch();
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  setFilter: (filter: SymlinkFilter) => {
    set({ filter });
  },
}));
