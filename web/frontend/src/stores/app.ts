import { create } from "zustand";
import type { SystemStatus, TokenStatus, SessionEntry } from "../api/types";
import * as api from "../api/client";

interface AppState {
  status: SystemStatus | null;
  tokens: TokenStatus[];
  sessions: SessionEntry[];
  loading: boolean;
  error: string | null;

  fetchStatus: () => Promise<void>;
  fetchTokens: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  clearSession: (key: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  status: null,
  tokens: [],
  sessions: [],
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

  fetchSessions: async () => {
    try {
      const sessions = await api.getSessions();
      set({ sessions, error: null });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  clearSession: async (key: string) => {
    await api.clearSession(key);
    await get().fetchSessions();
  },

  clearAllSessions: async () => {
    await api.clearAllSessions();
    await get().fetchSessions();
  },
}));
