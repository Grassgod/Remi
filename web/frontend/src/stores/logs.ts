import { create } from "zustand";
import type { LogEntry } from "../api/types";
import * as api from "../api/client";

interface LogsState {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  modules: string[];
  // Filters
  date: string;
  level: string | null;
  module: string | null;
  traceId: string | null;

  fetchLogs: () => Promise<void>;
  fetchModules: () => Promise<void>;
  setFilter: (key: "date" | "level" | "module" | "traceId", value: string | null) => void;
  loadMore: () => Promise<void>;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export const useLogsStore = create<LogsState>((set, get) => ({
  entries: [],
  total: 0,
  hasMore: false,
  loading: false,
  error: null,
  modules: [],
  date: todayStr(),
  level: null,
  module: null,
  traceId: null,

  fetchLogs: async () => {
    const { date, level, module, traceId } = get();
    set({ loading: true });
    try {
      const result = await api.getLogs({
        date, level: level ?? undefined, module: module ?? undefined,
        traceId: traceId ?? undefined, limit: 200, offset: 0,
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

  setFilter: (key, value) => {
    set({ [key]: value } as any);
  },

  loadMore: async () => {
    const { date, level, module, traceId, entries } = get();
    try {
      const result = await api.getLogs({
        date, level: level ?? undefined, module: module ?? undefined,
        traceId: traceId ?? undefined, limit: 200, offset: entries.length,
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
}));
