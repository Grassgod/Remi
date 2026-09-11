import { create } from "zustand";
import type { User, StorageAdapter } from "../types";
import { identify as identifyAnalytics, resetAnalytics } from "../analytics";
import { ApiError, type ApiClient, type LoginResponse } from "../api/client";
import { setCurrentWorkspace } from "../platform/workspace-storage";

export interface AuthStoreOptions {
  api: ApiClient;
  storage: StorageAdapter;
  onLogin?: () => void;
  onLogout?: () => void;
  /** When true, rely on HttpOnly cookies instead of localStorage for auth tokens. */
  cookieAuth?: boolean;
  /** Also revoke the browser's HttpOnly session on explicit token-mode logout. */
  revokeCookieOnLogout?: boolean;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;

  initialize: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<User>;
  loginWithLark: (code: string, redirectUri: string) => Promise<User>;
  loginWithToken: (token: string) => Promise<User>;
  loginWithPassword: (email: string, password: string) => Promise<LoginResponse>;
  logout: () => void;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
}

export function createAuthStore(options: AuthStoreOptions) {
  const { api, storage, onLogin, onLogout, cookieAuth, revokeCookieOnLogout } = options;

  return create<AuthState>((set, get) => ({
    user: null,
    isLoading: true,

    initialize: async () => {
      if (cookieAuth) {
        // In cookie mode, the HttpOnly cookie is sent automatically.
        // Try to fetch the current user — if the cookie exists the server will accept it.
        try {
          const user = await api.getMe();
          set({ user, isLoading: false });
        } catch {
          set({ user: null, isLoading: false });
        }
        return;
      }

      // Token mode: read from localStorage (Electron / legacy).
      const token = storage.getItem("multimira_token");
      if (!token) {
        set({ isLoading: false });
        return;
      }

      api.setToken(token);

      try {
        const user = await api.getMe();
        set({ user, isLoading: false });
      } catch (err) {
        // Only clear the stored token on a genuine auth failure (401). For
        // transient errors — network blips, backend rolling restarts, 5xx,
        // aborted fetches — keep the token so the next initialize() (next
        // page load or focus-refresh) can retry. The 401 path's token
        // cleanup is handled upstream by ApiClient.handleUnauthorized via
        // the onUnauthorized callback; we only need to reset the in-memory
        // user + workspace state here.
        if (err instanceof ApiError && err.status === 401) {
          setCurrentWorkspace(null, null);
        }
        set({ user: null, isLoading: false });
      }
    },

    sendCode: async (email: string) => {
      await api.sendCode(email);
    },

    verifyCode: async (email: string, code: string) => {
      const { token, user } = await api.verifyCode(email, code);
      if (!cookieAuth) {
        // Token mode: persist for Electron / legacy.
        storage.setItem("multimira_token", token);
        api.setToken(token);
      }
      onLogin?.();
      identifyAnalytics(user.id, { email: user.email, name: user.name });
      set({ user });
      return user;
    },

    loginWithLark: async (code: string, redirectUri: string) => {
      const { token, user } = await api.larkLogin(code, redirectUri);
      if (!cookieAuth) {
        storage.setItem("multimira_token", token);
        api.setToken(token);
      }
      onLogin?.();
      identifyAnalytics(user.id, { email: user.email, name: user.name });
      set({ user });
      return user;
    },

    loginWithToken: async (token: string) => {
      try {
        api.setToken(token);
        const user = await api.getMe();
        // getMe keeps a rendering fallback for other callers. An empty
        // identity must never validate a credential supplied on the login page.
        if (!user.id.trim()) throw new Error("Invalid authenticated identity");
        storage.setItem("multimira_token", token);
        onLogin?.();
        identifyAnalytics(user.id, { email: user.email, name: user.name });
        set({ user, isLoading: false });
        return user;
      } catch (error) {
        get().logout();
        set({ isLoading: false });
        throw error;
      }
    },

    loginWithPassword: async (email: string, password: string) => {
      try {
        const { token, user } = await api.passwordLogin(email, password);
        if (!cookieAuth) {
          storage.setItem("multimira_token", token);
          api.setToken(token);
        }
        onLogin?.();
        identifyAnalytics(user.id, { email: user.email, name: user.name });
        set({ user, isLoading: false });
        return { token, user };
      } catch (error) {
        // A rejected response or failed token write must not leave an old or
        // partially created session visible as a successful password login.
        get().logout();
        set({ isLoading: false });
        throw error;
      }
    },

    logout: () => {
      storage.removeItem("multimira_token");
      api.setToken(null);
      if (cookieAuth || revokeCookieOnLogout) {
        // Clear server-side HttpOnly cookie.
        api.logout().catch(() => {});
      }
      setCurrentWorkspace(null, null);
      resetAnalytics();
      onLogout?.();
      set({ user: null });
    },

    setUser: (user: User) => {
      set({ user });
    },

    refreshMe: async () => {
      const user = await api.getMe();
      set({ user });
    },
  }));
}
