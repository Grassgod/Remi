import { create } from "zustand";
import type { CurrentUser } from "../api/client";
import * as api from "../api/client";

interface AuthState {
  user: CurrentUser | null;
  ssoConfigured: boolean;
  loading: boolean;
  initialized: boolean;
  fetchMe: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ssoConfigured: false,
  loading: false,
  initialized: false,

  fetchMe: async () => {
    set({ loading: true });
    try {
      const res = await api.getCurrentUser();
      set({
        user: res.user,
        ssoConfigured: res.ssoConfigured,
        loading: false,
        initialized: true,
      });
    } catch {
      set({ user: null, loading: false, initialized: true });
    }
  },

  logout: async () => {
    await api.ssoLogoutApi();
    set({ user: null });
    // Hard redirect so all stores reset
    window.location.hash = "#/login";
    window.location.reload();
  },
}));
