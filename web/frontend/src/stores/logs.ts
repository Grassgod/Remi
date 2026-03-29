import { create } from "zustand";
import type { LogEntry, LogStats } from "../api/types";
import * as api from "../api/client";

interface LogsState {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  modules: string[];

  // Stats
  stats: LogStats | null;
  statsLoading: boolean;

  // Filters
  date: string;
  level: string | null;
  module: string | null;
  traceId: string | null;
  search: string | null;

  // UI state
  autoRefresh: boolean;
  expandedIndex: number | null;

  // Actions
  fetchLogs: () => Promise<void>;
  fetchModules: () => Promise<void>;
  fetchStats: () => Promise<void>;
  setFilter: (key: "date" | "level" | "module" | "traceId" | "search", value: string | null) => void;
  loadMore: () => Promise<void>;
  toggleAutoRefresh: () => void;
  setExpandedIndex: (i: number | null) => void;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export const useLogsStore = create<LogsState>((set, get) => ({
  entries: [],
  total: 0,
  hasMore: false,
  loading: false,
  error: null,
  modules: [],

  stats: null,
  statsLoading: false,

  date: todayStr(),
  level: null,
  module: null,
  traceId: null,
  search: null,

  autoRefresh: false,
  expandedIndex: null,

  fetchLogs: async () => {
    const { date, level, module, traceId, search } = get();
    set({ loading: true });
    try {
      const result = await api.getLogs({
        date,
        level: level ?? undefined,
        module: module ?? undefined,
        traceId: traceId ?? undefined,
        search: search ?? undefined,
        limit: 200,
        offset: 0,
      });
      set({ entries: result.entries, total: result.total, hasMore: result.hasMore, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchModules: async () => {
    try {
      const modules = await api.getLogModules(get().date);
      set({ modules });
    } catch { /* ignore */ }
  },

  fetchStats: async () => {
    const { date, level, module, traceId, search } = get();
    set({ statsLoading: true });
    try {
      const stats = await api.getLogStats({
        date,
        level: level ?? undefined,
        module: module ?? undefined,
        traceId: traceId ?? undefined,
        search: search ?? undefined,
      });
      set({ stats, statsLoading: false });
    } catch {
      set({ statsLoading: false });
    }
  },

  setFilter: (key, value) => {
    set({ [key]: value, expandedIndex: null } as any);
  },

  loadMore: async () => {
    const { date, level, module, traceId, search, entries } = get();
    try {
      const result = await api.getLogs({
        date,
        level: level ?? undefined,
        module: module ?? undefined,
        traceId: traceId ?? undefined,
        search: search ?? undefined,
        limit: 200,
        offset: entries.length,
      });
      set({
        entries: [...entries, ...result.entries],
        total: result.total,
        hasMore: result.hasMore,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  toggleAutoRefresh: () => {
    set((s) => ({ autoRefresh: !s.autoRefresh }));
  },

  setExpandedIndex: (i) => {
    set((s) => ({ expandedIndex: s.expandedIndex === i ? null : i }));
  },
}));
