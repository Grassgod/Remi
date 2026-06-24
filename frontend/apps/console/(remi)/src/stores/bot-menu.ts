import { create } from "zustand";
import * as api from "../api/client";

export interface MenuBehavior {
  type: "target" | "event_key" | "send_message";
  url?: string;
  event_key?: string;
  is_primary?: boolean;
}

export interface MenuIcon {
  token?: string;
  color?: string;
  file_key?: string;
}

export interface MenuItem {
  name: string;
  i18n_name?: Record<string, string>;
  icon?: MenuIcon;
  tag?: string;
  behaviors?: MenuBehavior[];
  children?: MenuItem[];
}

export interface MenuUser {
  user_id: string;
  user_id_type?: string;
  label?: string;
  items: MenuItem[];
}

export interface BotMenuConfig {
  default?: MenuItem[];
  users?: MenuUser[];
}

interface BotMenuState {
  config: BotMenuConfig;
  loading: boolean;
  syncing: boolean;
  dirty: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  save: () => Promise<void>;
  sync: () => Promise<void>;
  setConfig: (config: BotMenuConfig) => void;

  // Default menu helpers
  addDefaultItem: (item: MenuItem) => void;
  updateDefaultItem: (index: number, item: MenuItem) => void;
  removeDefaultItem: (index: number) => void;

  // Children helpers
  addChild: (parentIndex: number, child: MenuItem) => void;
  updateChild: (parentIndex: number, childIndex: number, child: MenuItem) => void;
  removeChild: (parentIndex: number, childIndex: number) => void;
}

export const useBotMenuStore = create<BotMenuState>((set, get) => ({
  config: {},
  loading: false,
  syncing: false,
  dirty: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const config = await api.getBotMenu();
      set({ config, loading: false, dirty: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  save: async () => {
    set({ loading: true, error: null });
    try {
      await api.updateBotMenu(get().config);
      set({ loading: false, dirty: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  sync: async () => {
    set({ syncing: true, error: null });
    try {
      // Save first, then sync
      await api.updateBotMenu(get().config);
      await api.syncBotMenu();
      set({ syncing: false, dirty: false });
    } catch (err: any) {
      set({ error: err.message, syncing: false });
    }
  },

  setConfig: (config) => set({ config, dirty: true }),

  addDefaultItem: (item) => {
    const { config } = get();
    const items = [...(config.default ?? []), item];
    set({ config: { ...config, default: items }, dirty: true });
  },

  updateDefaultItem: (index, item) => {
    const { config } = get();
    const items = [...(config.default ?? [])];
    items[index] = item;
    set({ config: { ...config, default: items }, dirty: true });
  },

  removeDefaultItem: (index) => {
    const { config } = get();
    const items = (config.default ?? []).filter((_, i) => i !== index);
    set({ config: { ...config, default: items }, dirty: true });
  },

  addChild: (parentIndex, child) => {
    const { config } = get();
    const items = [...(config.default ?? [])];
    const parent = { ...items[parentIndex] };
    parent.children = [...(parent.children ?? []), child];
    // When adding children, remove behaviors (mutually exclusive)
    delete parent.behaviors;
    items[parentIndex] = parent;
    set({ config: { ...config, default: items }, dirty: true });
  },

  updateChild: (parentIndex, childIndex, child) => {
    const { config } = get();
    const items = [...(config.default ?? [])];
    const parent = { ...items[parentIndex] };
    const children = [...(parent.children ?? [])];
    children[childIndex] = child;
    parent.children = children;
    items[parentIndex] = parent;
    set({ config: { ...config, default: items }, dirty: true });
  },

  removeChild: (parentIndex, childIndex) => {
    const { config } = get();
    const items = [...(config.default ?? [])];
    const parent = { ...items[parentIndex] };
    parent.children = (parent.children ?? []).filter((_, i) => i !== childIndex);
    items[parentIndex] = parent;
    set({ config: { ...config, default: items }, dirty: true });
  },
}));
