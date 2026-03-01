import { create } from "zustand";
import type { AnalyticsSummary, TokenMetricEntry } from "../api/types";
import * as api from "../api/client";

interface AnalyticsState {
  summary: AnalyticsSummary | null;
  recentMetrics: TokenMetricEntry[];
  loading: boolean;
  error: string | null;

  fetchSummary: () => Promise<void>;
  fetchRecent: (limit?: number) => Promise<void>;
  triggerCliScan: () => Promise<{ count: number }>;
}

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  summary: null,
  recentMetrics: [],
  loading: false,
  error: null,

  fetchSummary: async () => {
    set({ loading: true });
    try {
      const summary = await api.getAnalyticsSummary();
      set({ summary, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fetchRecent: async (limit = 50) => {
    try {
      const recentMetrics = await api.getRecentMetrics(limit);
      set({ recentMetrics, error: null });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  triggerCliScan: async () => {
    const result = await api.scanCliUsage();
    return result;
  },
}));
