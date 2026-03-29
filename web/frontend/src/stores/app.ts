import { create } from "zustand";
import type { SystemStatus, TokenStatus } from "../api/types";
import * as api from "../api/client";

interface AppState {
  status: SystemStatus | null;
  tokens: TokenStatus[];
  loading: boolean;
  error: string | null;

  fetchStatus: () => Promise<void>;
  fetchTokens: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  status: null,
  tokens: [],
  loading: false,
  error: null,

  fetchStatus: async () => {
    try {
      const status = await api.getStatus();
      set({ status, error: null });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  fetchTokens: async () => {
    try {
      const tokens = await api.getTokenStatus();
      set({ tokens, error: null });
    } catch (e: any) {
      set({ error: e.message });
    }
  },
}));
