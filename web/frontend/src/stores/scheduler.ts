import { create } from "zustand";
import type { SchedulerStatus, CronRunEntry, DailySchedulerSummary } from "../api/types";
import * as api from "../api/client";

interface SchedulerState {
  status: SchedulerStatus | null;
  history: CronRunEntry[];
  summary: DailySchedulerSummary[];
  selectedJobId: string | undefined;
  loading: boolean;

  fetchStatus: () => Promise<void>;
  fetchHistory: (jobId?: string) => Promise<void>;
  fetchSummary: (days?: number) => Promise<void>;
  setSelectedJobId: (jobId: string | undefined) => void;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  status: null,
  history: [],
  summary: [],
  selectedJobId: undefined,
  loading: false,

  fetchStatus: async () => {
    try {
      const status = await api.getSchedulerStatus();
      set({ status });
    } catch { /* non-critical */ }
  },

  fetchHistory: async (jobId?: string) => {
    set({ loading: true, selectedJobId: jobId });
    try {
      const history = await api.getSchedulerHistory(jobId);
      set({ history, loading: false });
    } catch {
      set({ history: [], loading: false });
    }
  },

  fetchSummary: async (days = 7) => {
    try {
      const summary = await api.getSchedulerSummary(days);
      set({ summary });
    } catch { /* non-critical */ }
  },

  setSelectedJobId: (jobId: string | undefined) => {
    set({ selectedJobId: jobId });
    get().fetchHistory(jobId);
  },
}));
