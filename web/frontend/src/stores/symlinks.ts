import { create } from "zustand";
import type { SymlinkMapping, SymlinksStatus } from "../api/types";
import * as api from "../api/client";

/** Replace /home/<user>/ with ~/ */
export function displayPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/");
}

/** Group structure for the tree view */
export interface ProjectGroup {
  alias: string;
  hash: string;
  dirMapping: SymlinkMapping;
  memoryMapping: SymlinkMapping | null;
  wikiMapping: SymlinkMapping | null;
}

export interface GroupedMappings {
  soul: SymlinkMapping | null;
  global: {
    dirMapping: SymlinkMapping | null;
    memoryMapping: SymlinkMapping | null;
    wikiMapping: SymlinkMapping | null;
  };
  projects: ProjectGroup[];
}

function buildGroups(mappings: SymlinkMapping[]): GroupedMappings {
  const result: GroupedMappings = {
    soul: null,
    global: { dirMapping: null, memoryMapping: null, wikiMapping: null },
    projects: [],
  };

  const projectDirs = new Map<string, SymlinkMapping>();
  const projectMemory = new Map<string, SymlinkMapping>();
  const projectWiki = new Map<string, SymlinkMapping>();

  for (const m of mappings) {
    switch (m.category) {
      case "soul":
        result.soul = m;
        break;
      case "global":
        result.global.dirMapping = m;
        break;
      case "memory":
        if (m.projectAlias === "~ (home)") {
          result.global.memoryMapping = m;
        } else if (m.parentHash) {
          projectMemory.set(m.parentHash, m);
        }
        break;
      case "wiki":
        if (m.projectAlias === "~ (home)") {
          result.global.wikiMapping = m;
        } else if (m.parentHash) {
          projectWiki.set(m.parentHash, m);
        }
        break;
      case "project": {
        const hash = m.source.split("/").pop() || "";
        projectDirs.set(hash, m);
        break;
      }
    }
  }

  for (const [hash, dirMapping] of projectDirs) {
    result.projects.push({
      alias: dirMapping.projectAlias || hash,
      hash,
      dirMapping,
      memoryMapping: projectMemory.get(hash) || null,
      wikiMapping: projectWiki.get(hash) || null,
    });
  }

  result.projects.sort((a, b) => a.alias.localeCompare(b.alias));
  return result;
}

interface SymlinksState {
  mappings: SymlinkMapping[];
  stats: SymlinksStatus["stats"];
  grouped: GroupedMappings;
  loading: boolean;
  error: string | null;
  expandedSections: Set<string>;
  expandedProjects: Set<string>;

  fetch: () => Promise<void>;
  fixAll: () => Promise<void>;
  toggleSection: (section: string) => void;
  toggleProject: (alias: string) => void;
}

export const useSymlinksStore = create<SymlinksState>((set, get) => ({
  mappings: [],
  stats: { total: 0, ok: 0, broken: 0, notLinked: 0 },
  grouped: { soul: null, global: { dirMapping: null, memoryMapping: null, wikiMapping: null }, projects: [] },
  loading: false,
  error: null,
  expandedSections: new Set(["global", "projects"]),
  expandedProjects: new Set<string>(),

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.getSymlinksStatus();
      const grouped = buildGroups(data.mappings);
      const expanded = new Set(get().expandedProjects);
      for (const p of grouped.projects) {
        const hasBroken = [p.dirMapping, p.memoryMapping, p.wikiMapping].some(
          (m) => m && m.status !== "ok"
        );
        if (hasBroken) expanded.add(p.alias);
      }
      set({ mappings: data.mappings, stats: data.stats, grouped, loading: false, expandedProjects: expanded });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  fixAll: async () => {
    set({ loading: true, error: null });
    try {
      await api.fixAllSymlinks();
      await get().fetch();
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  toggleSection: (section: string) => {
    const next = new Set(get().expandedSections);
    next.has(section) ? next.delete(section) : next.add(section);
    set({ expandedSections: next });
  },

  toggleProject: (alias: string) => {
    const next = new Set(get().expandedProjects);
    next.has(alias) ? next.delete(alias) : next.add(alias);
    set({ expandedProjects: next });
  },
}));
