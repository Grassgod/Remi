import { create } from "zustand";
import * as api from "../api/client";
import type { McpScope, McpScopeDetail } from "../api/types";

interface McpState {
  scopes: McpScope[];
  selectedScope: string | null;
  detail: McpScopeDetail | null;
  loading: boolean;
  error: string | null;

  fetchScopes: () => Promise<void>;
  selectScope: (id: string | null) => Promise<void>;
  writeScope: (content: string) => Promise<void>;
  deleteServer: (serverName: string) => Promise<void>;
  mergeServers: (content: string) => Promise<{ added: string[] }>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  scopes: [],
  selectedScope: null,
  detail: null,
  loading: false,
  error: null,

  fetchScopes: async () => {
    try {
      const scopes = await api.getMcpScopes();
      set({ scopes });
      // Auto-select first scope if none selected
      const { selectedScope } = get();
      if (!selectedScope && scopes.length > 0) {
        get().selectScope(scopes[0].id);
      }
    } catch { /* non-critical */ }
  },

  selectScope: async (id: string | null) => {
    set({ selectedScope: id, detail: null, error: null });
    if (!id) return;
    set({ loading: true });
    try {
      const detail = await api.getMcpScopeDetail(id);
      set({ detail, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e.message ?? "failed to load" });
    }
  },

  writeScope: async (content: string) => {
    const { selectedScope } = get();
    if (!selectedScope) return;
    set({ error: null });
    try {
      await api.writeMcpScope(selectedScope, content);
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
    } catch (e: any) {
      set({ error: e.message ?? "failed to save" });
      throw e;
    }
  },

  deleteServer: async (serverName: string) => {
    const { selectedScope } = get();
    if (!selectedScope) return;
    set({ error: null });
    try {
      await api.deleteMcpServer(selectedScope, serverName);
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
    } catch (e: any) {
      set({ error: e.message ?? "failed to delete" });
    }
  },

  mergeServers: async (content: string) => {
    const { selectedScope } = get();
    if (!selectedScope) throw new Error("no scope selected");
    set({ error: null });
    try {
      const result = await api.mergeMcpServers(selectedScope, content);
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
      return { added: result.added };
    } catch (e: any) {
      set({ error: e.message ?? "failed to merge" });
      throw e;
    }
  },
}));
