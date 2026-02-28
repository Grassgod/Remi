import { create } from "zustand";
import type { EntitySummary, EntityDetail, SearchResult, DailyLogEntry } from "../api/types";
import * as api from "../api/client";

interface MemoryState {
  entities: EntitySummary[];
  currentEntity: EntityDetail | null;
  globalMemory: string;
  dailyDates: DailyLogEntry[];
  dailyContent: string;
  searchResults: SearchResult[];
  loading: boolean;

  fetchEntities: () => Promise<void>;
  fetchEntity: (type: string, name: string) => Promise<void>;
  fetchGlobalMemory: () => Promise<void>;
  saveGlobalMemory: (content: string) => Promise<void>;
  fetchDailyDates: () => Promise<void>;
  fetchDaily: (date: string) => Promise<void>;
  search: (q: string) => Promise<void>;
  deleteEntity: (type: string, name: string) => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  entities: [],
  currentEntity: null,
  globalMemory: "",
  dailyDates: [],
  dailyContent: "",
  searchResults: [],
  loading: false,

  fetchEntities: async () => {
    set({ loading: true });
    try {
      const entities = await api.getEntities();
      set({ entities, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  fetchEntity: async (type: string, name: string) => {
    set({ loading: true });
    try {
      const entity = await api.getEntity(type, name);
      set({ currentEntity: entity, loading: false });
    } catch {
      set({ currentEntity: null, loading: false });
    }
  },

  fetchGlobalMemory: async () => {
    try {
      const { content } = await api.getGlobalMemory();
      set({ globalMemory: content });
    } catch {}
  },

  saveGlobalMemory: async (content: string) => {
    await api.putGlobalMemory(content);
    set({ globalMemory: content });
  },

  fetchDailyDates: async () => {
    try {
      const dates = await api.getDailyDates();
      set({ dailyDates: dates });
    } catch {}
  },

  fetchDaily: async (date: string) => {
    try {
      const { content } = await api.getDaily(date);
      set({ dailyContent: content || "" });
    } catch {
      set({ dailyContent: "" });
    }
  },

  search: async (q: string) => {
    if (!q) { set({ searchResults: [] }); return; }
    try {
      const results = await api.searchMemory(q);
      set({ searchResults: results });
    } catch {}
  },

  deleteEntity: async (type: string, name: string) => {
    await api.deleteEntity(type, name);
    await get().fetchEntities();
  },
}));
