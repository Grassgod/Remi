/**
 * Bot Menu Syncer — sync menu config from remi.toml to Feishu bot_menu API.
 *
 * Supports both global default menus and per-user personalized menus (千人千面).
 * API endpoint: POST/GET/DELETE https://fsopen.bytedance.net/open-apis/bot/v3/bot_menu
 */

import type {
  BotMenuConfig,
  BotMenuItemConfig,
  BotMenuBehavior,
  BotMenuUserConfig,
} from "../../config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("menu-sync");

// The bot_menu API uses the bytedance internal endpoint
const FSOPEN_BASE = "https://fsopen.bytedance.net/open-apis";
const BOT_MENU_API = `${FSOPEN_BASE}/bot/v3/bot_menu`;

// ── Internal token management ────────────────────────────────

interface FsopenCredentials {
  appId: string;
  appSecret: string;
}

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getFsopenToken(creds: FsopenCredentials): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) {
    return _cachedToken.token;
  }

  const res = await fetch(`${FSOPEN_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = await res.json() as { code: number; tenant_access_token?: string; expire?: number; msg?: string };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get fsopen token: ${data.msg ?? `code ${data.code}`}`);
  }

  // Cache with 5 min buffer before expiry
  _cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + ((data.expire ?? 7200) - 300) * 1000,
  };
  return _cachedToken.token;
}

// ── API payload types ────────────────────────────────────────

interface ApiMenuBehavior {
  type: "target" | "event_key" | "send_message";
  target?: {
    common_url: string;
    ios_url?: string;
    android_url?: string;
    pc_url?: string;
    web_url?: string;
  };
  event_key?: string;
  is_primary?: boolean;
}

interface ApiMenuIcon {
  ud_icon?: { token: string; color?: string };
  file_key?: string;
}

interface ApiMenuItem {
  name: string;
  i18n_name?: Record<string, string>;
  icon?: ApiMenuIcon;
  tag?: string;
  behaviors?: ApiMenuBehavior[];
  children?: ApiMenuItem[];
}

interface ApiMenuPayload {
  user_id?: string;
  bot_menu: {
    bot_menu_items: ApiMenuItem[];
  };
}

// ── Config → API payload conversion ─────────────────────────

function behaviorToApi(b: BotMenuBehavior): ApiMenuBehavior {
  const api: ApiMenuBehavior = { type: b.type };

  if (b.type === "target" && b.url) {
    api.target = { common_url: b.url };
  }
  if (b.type === "event_key" && b.eventKey) {
    api.event_key = b.eventKey;
  }
  if (b.isPrimary != null) {
    api.is_primary = b.isPrimary;
  }

  return api;
}

function iconToApi(icon: BotMenuItemConfig["icon"]): ApiMenuIcon | undefined {
  if (!icon) return undefined;

  const api: ApiMenuIcon = {};
  if (icon.token) {
    api.ud_icon = { token: icon.token, color: icon.color };
  }
  if (icon.fileKey) {
    api.file_key = icon.fileKey;
  }
  return Object.keys(api).length > 0 ? api : undefined;
}

function menuItemToApi(item: BotMenuItemConfig): ApiMenuItem {
  const api: ApiMenuItem = { name: item.name };

  // i18n_name is required by the API — fallback to name if not provided
  api.i18n_name = item.i18nName ?? { en_us: item.name };
  if (item.icon) api.icon = iconToApi(item.icon);
  if (item.tag) api.tag = item.tag;

  // behaviors and children are mutually exclusive
  if (item.children && item.children.length > 0) {
    api.children = item.children.map(menuItemToApi);
  } else if (item.behaviors && item.behaviors.length > 0) {
    api.behaviors = item.behaviors.map(behaviorToApi);
  }

  return api;
}

// ── MenuSyncer ──────────────────────────────────────────────

export class MenuSyncer {
  private _creds: FsopenCredentials;

  constructor(creds: FsopenCredentials) {
    this._creds = creds;
  }

  /**
   * Sync all menus from config to Feishu API.
   * - Default menu items are applied to each user in triggerUserIds
   * - Per-user configs override the default for specific users
   *
   * Note: The 千人千面 API always requires a user_id. There is no way to
   * set a "global" menu via API — that must be done in the developer console.
   */
  async syncAll(config: BotMenuConfig, triggerUserIds?: string[]): Promise<void> {
    if (!config.default?.length && !config.users?.length) {
      log.info("no bot_menu config found, skipping sync");
      return;
    }

    // Build a map of userId → items (users override default)
    const userMenuMap = new Map<string, BotMenuItemConfig[]>();

    // Apply default menu to all trigger users
    if (config.default?.length && triggerUserIds?.length) {
      for (const uid of triggerUserIds) {
        userMenuMap.set(uid, config.default);
      }
    }

    // Override with per-user menus
    if (config.users) {
      for (const user of config.users) {
        userMenuMap.set(user.userId, user.items);
      }
    }

    // Sync each user
    for (const [userId, items] of userMenuMap) {
      const payload: ApiMenuPayload = {
        user_id: userId,
        bot_menu: { bot_menu_items: items.map(menuItemToApi) },
      };
      await this._postMenu(payload);
      log.info(`synced menu for ${userId} (${items.length} items)`);
    }
  }

  /**
   * Sync per-user personalized menu (千人千面).
   */
  private async _syncUserMenu(user: BotMenuUserConfig): Promise<void> {
    const payload: ApiMenuPayload = {
      user_id: user.userId,
      bot_menu: {
        bot_menu_items: user.items.map(menuItemToApi),
      },
    };
    const userIdType = user.userIdType ?? "open_id";
    await this._postMenu(payload, userIdType);
  }

  /**
   * Get the current menu for a user (or global if no userId).
   */
  async getMenu(userId?: string, userIdType = "open_id"): Promise<any> {
    const token = await getFsopenToken(this._creds);
    const params = new URLSearchParams();
    if (userId) {
      params.set("user_id", userId);
      params.set("user_id_type", userIdType);
    }
    const url = `${BOT_MENU_API}${params.toString() ? `?${params}` : ""}`;

    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) {
      log.warn(`GET menu failed: ${data.msg} (code ${data.code})`);
    }
    return data;
  }

  /**
   * Delete a user's personalized menu.
   */
  async deleteUserMenu(userId: string, userIdType = "open_id"): Promise<void> {
    const token = await getFsopenToken(this._creds);
    const params = new URLSearchParams({ user_id_type: userIdType });
    const url = `${BOT_MENU_API}?${params}`;

    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await res.json();
    if (data.code !== 0) {
      log.warn(`DELETE menu for ${userId} failed: ${data.msg} (code ${data.code})`);
    }
  }

  /**
   * POST menu to API (create or update).
   */
  private async _postMenu(payload: ApiMenuPayload, userIdType = "open_id"): Promise<void> {
    const token = await getFsopenToken(this._creds);
    const params = new URLSearchParams({ user_id_type: userIdType });
    const url = `${BOT_MENU_API}?${params}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.code !== 0) {
      log.warn(`POST menu failed: ${data.msg} (code ${data.code})`);
      throw new Error(`Bot menu sync failed: ${data.msg}`);
    }
  }
}
