import { create } from "zustand";
import type { AnalyticsSummary, TokenMetricEntry } from "../api/types";
import * as api from "../api/client";

interface AnalyticsState {
  summary: AnalyticsSummary | null;
  recentMetrics: TokenMetricEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;

  fetchSummary: () => Promise<void>;
  fetchRecent: (limit?: number) => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  summary: null,
  recentMetrics: [],
  loading: false,
  refreshing: false,
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
    set({ loading: true });
    try {
      const recentMetrics = await api.getRecentMetrics(limit);
      set({ recentMetrics, loading: false, error: null });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  refreshAll: async () => {
    set({ refreshing: true });
    try {
      const [summary, recentMetrics] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getRecentMetrics(50),
      ]);
      set({ summary, recentMetrics, refreshing: false, error: null });
    } catch (e: any) {
      set({ error: e.message, refreshing: false });
    }
  },
}));
