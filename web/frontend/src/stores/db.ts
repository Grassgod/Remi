import { create } from "zustand";
import { getDbStats, getDbKv, getDbEmbeddings } from "../api/client";
import type { DbStats, KvEntry, EmbeddingEntry } from "../api/types";

interface DbStore {
  stats: DbStats | null;
  kvEntries: KvEntry[];
  embeddings: EmbeddingEntry[];
  fetchStats: () => Promise<void>;
  fetchKv: () => Promise<void>;
  fetchEmbeddings: () => Promise<void>;
}

export const useDbStore = create<DbStore>((set) => ({
  stats: null,
  kvEntries: [],
  embeddings: [],

  fetchStats: async () => {
    try {
      const stats = await getDbStats();
      set({ stats });
    } catch { /* ignore */ }
  },

  fetchKv: async () => {
    try {
      const kvEntries = await getDbKv();
      set({ kvEntries });
    } catch { /* ignore */ }
  },

  fetchEmbeddings: async () => {
    try {
      const embeddings = await getDbEmbeddings();
      set({ embeddings });
    } catch { /* ignore */ }
  },
}));
