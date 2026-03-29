import { create } from "zustand";
import type { TraceListItem, TraceStats, TraceDetail } from "../api/types";
import * as api from "../api/client";

const PAGE_SIZE = 50;

interface TracesState {
  traces: TraceListItem[];
  stats: TraceStats | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  // Filters
  date: string;
  statusFilter: string;
  search: string;
  // Detail
  selectedId: number | null;
  detail: TraceDetail | null;
  detailLoading: boolean;
  // Actions
  setDate: (date: string) => void;
  setStatusFilter: (status: string) => void;
  setSearch: (search: string) => void;
  fetchTraces: () => Promise<void>;
  loadMore: () => Promise<void>;
  fetchDetail: (id: number) => Promise<void>;
  clearSelection: () => void;
}

export const useTracesStore = create<TracesState>((set, get) => ({
  traces: [],
  stats: null,
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  date: new Date().toISOString().slice(0, 10),
  statusFilter: "",
  search: "",
  selectedId: null,
  detail: null,
  detailLoading: false,

  setDate: (date) => {
    set({ date, selectedId: null, detail: null, traces: [] });
    get().fetchTraces();
  },

  setStatusFilter: (statusFilter) => {
    set({ statusFilter, selectedId: null, detail: null, traces: [] });
    get().fetchTraces();
  },

  setSearch: (search) => {
    set({ search, selectedId: null, detail: null, traces: [] });
    get().fetchTraces();
  },

  fetchTraces: async () => {
    const { date, statusFilter, search } = get();
    set({ loading: true });
    try {
      const [result, stats] = await Promise.all([
        api.getTraces({ date, limit: PAGE_SIZE, status: statusFilter || undefined, search: search || undefined }),
        api.getTraceStats(date),
      ]);
      set({ traces: result.items, hasMore: result.hasMore, stats, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  loadMore: async () => {
    const { date, statusFilter, search, traces } = get();
    set({ loadingMore: true });
    try {
      const result = await api.getTraces({
        date, limit: PAGE_SIZE, offset: traces.length,
        status: statusFilter || undefined, search: search || undefined,
      });
      set({ traces: [...traces, ...result.items], hasMore: result.hasMore, loadingMore: false });
    } catch (e: any) {
      set({ error: e.message, loadingMore: false });
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
