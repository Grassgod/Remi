import { create } from "zustand";
import type { AgentInfo, AgentDetail, AgentRunEntry, McpServerInfo } from "../api/types";
import * as api from "../api/client";

interface AgentsState {
  agents: AgentInfo[];
  selectedAgent: string | null;
  detail: AgentDetail | null;
  runs: AgentRunEntry[];
  mcpServers: McpServerInfo[];
  loading: boolean;

  fetchAgents: () => Promise<void>;
  selectAgent: (name: string | null) => Promise<void>;
  fetchRuns: (name: string) => Promise<void>;
  fetchMcpServers: () => Promise<void>;
  saveClaudeMd: (name: string, content: string) => Promise<void>;
  saveSettings: (name: string, content: string) => Promise<void>;
  saveSkill: (name: string, skillName: string, content: string) => Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  selectedAgent: null,
  detail: null,
  runs: [],
  mcpServers: [],
  loading: false,

  fetchAgents: async () => {
    try {
      const agents = await api.getAgents();
      set({ agents });
    } catch { /* non-critical */ }
  },

  selectAgent: async (name: string | null) => {
    set({ selectedAgent: name, detail: null, runs: [] });
    if (!name) return;
    set({ loading: true });
    try {
      const [detail, runs] = await Promise.all([
        api.getAgentDetail(name),
        api.getAgentRuns(name),
      ]);
      set({ detail, runs, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  fetchRuns: async (name: string) => {
    try {
      const runs = await api.getAgentRuns(name);
      set({ runs });
    } catch { /* non-critical */ }
  },

  fetchMcpServers: async () => {
    try {
      const mcpServers = await api.getMcpServers();
      set({ mcpServers });
    } catch { /* non-critical */ }
  },

  saveClaudeMd: async (name: string, content: string) => {
    await api.updateAgentClaudeMd(name, content);
    // Refresh detail
    get().selectAgent(name);
  },

  saveSettings: async (name: string, content: string) => {
    await api.updateAgentSettings(name, content);
    get().selectAgent(name);
  },

  saveSkill: async (name: string, skillName: string, content: string) => {
    await api.updateAgentSkill(name, skillName, content);
    get().selectAgent(name);
  },
}));
