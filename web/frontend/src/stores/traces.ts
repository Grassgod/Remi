import { create } from "zustand";
import type { TraceListItem, TraceStats, TraceDetail } from "../api/types";
import * as api from "../api/client";

interface TracesState {
  // List
  traces: TraceListItem[];
  stats: TraceStats | null;
  loading: boolean;
  error: string | null;
  // Filters
  date: string; // YYYY-MM-DD
  statusFilter: string; // "" = all, "completed", "failed", "processing"
  // Detail
  selectedId: number | null;
  detail: TraceDetail | null;
  detailLoading: boolean;
  // Actions
  setDate: (date: string) => void;
  setStatusFilter: (status: string) => void;
  fetchTraces: () => Promise<void>;
  fetchDetail: (id: number) => Promise<void>;
  clearSelection: () => void;
}

export const useTracesStore = create<TracesState>((set, get) => ({
  traces: [],
  stats: null,
  loading: false,
  error: null,
  date: new Date().toISOString().slice(0, 10),
  statusFilter: "",
  selectedId: null,
  detail: null,
  detailLoading: false,

  setDate: (date) => {
    set({ date, selectedId: null, detail: null });
    get().fetchTraces();
  },

  setStatusFilter: (statusFilter) => {
    set({ statusFilter, selectedId: null, detail: null });
    get().fetchTraces();
  },

  fetchTraces: async () => {
    const { date, statusFilter } = get();
    set({ loading: true });
    try {
      const [traces, stats] = await Promise.all([
        api.getTraces(date, 200, statusFilter || undefined),
        api.getTraceStats(date),
      ]);
      set({ traces, stats, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchDetail: async (id) => {
    set({ selectedId: id, detailLoading: true });
    try {
      const detail = await api.getTraceDetail(id);
      set({ detail, detailLoading: false });
    } catch (e: any) {
      set({ error: e.message, detailLoading: false });
    }
  },

  clearSelection: () => set({ selectedId: null, detail: null }),
}));
