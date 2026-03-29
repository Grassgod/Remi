/**
 * Board Zustand store — projects, missions, polling.
 */

import { create } from "zustand";
import type { Project, Mission, ProjectStats } from "../api";
import * as api from "../api";

interface BoardState {
  projects: Project[];
  currentSlug: string | null;
  missions: Mission[];
  stats: ProjectStats | null;
  loading: boolean;
  error: string | null;

  fetchProjects: () => Promise<void>;
  selectProject: (slug: string) => Promise<void>;
  refreshMissions: () => Promise<void>;
  moveMission: (id: string, newStatus: string) => Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  projects: [],
  currentSlug: null,
  missions: [],
  stats: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    try {
      const projects = await api.fetchProjects();
      set({ projects });
      // Auto-select first project if none selected
      if (!get().currentSlug && projects.length > 0) {
        await get().selectProject(projects[0].slug);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  selectProject: async (slug) => {
    set({ currentSlug: slug, loading: true, error: null });
    try {
      const [missions, stats] = await Promise.all([
        api.fetchMissions(slug),
        api.fetchStats(slug),
      ]);
      set({ missions, stats, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  refreshMissions: async () => {
    const slug = get().currentSlug;
    if (!slug) return;
    try {
      const [missions, stats] = await Promise.all([
        api.fetchMissions(slug),
        api.fetchStats(slug),
      ]);
      set({ missions, stats });
    } catch {
      // Silent refresh failure
    }
  },

  moveMission: async (id, newStatus) => {
    // Optimistic update
    set((s) => ({
      missions: s.missions.map((m) =>
        m.id === id ? { ...m, status: newStatus } : m
      ),
    }));
    try {
      await api.updateMission(id, { status: newStatus as any });
    } catch {
      // Revert on failure
      await get().refreshMissions();
    }
  },
}));
