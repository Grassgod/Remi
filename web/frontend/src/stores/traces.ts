import { create } from "zustand";
import type { TraceData } from "../api/types";
import * as api from "../api/client";

interface TracesState {
  traces: TraceData[];
  selectedTrace: TraceData | null;
  loading: boolean;
  error: string | null;
  fetchTraces: (date?: string, limit?: number) => Promise<void>;
  fetchTrace: (traceId: string) => Promise<void>;
  clearSelection: () => void;
}

export const useTracesStore = create<TracesState>((set) => ({
  traces: [],
  selectedTrace: null,
  loading: false,
  error: null,

  fetchTraces: async (date, limit = 50) => {
    set({ loading: true });
    try {
      const traces = await api.getTraces(date, limit);
      set({ traces, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchTrace: async (traceId) => {
    try {
      const selectedTrace = await api.getTrace(traceId);
      set({ selectedTrace, error: null });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  clearSelection: () => set({ selectedTrace: null }),
}));
