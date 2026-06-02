/**
 * Bot Menu Syncer — sync menu config from remi.toml to Feishu bot_menu API.
 *
 * Supports both global default menus and per-user personalized menus (千人千面).
 */

import type { BotMenuConfig, BotMenuItemConfig, BotMenuBehavior, BotMenuUserConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("menu-sync");

function getBaseUrl(domain?: string): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

interface FsopenCredentials {
  appId: string;
  appSecret: string;
  domain?: string;
}

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getFsopenToken(creds: FsopenCredentials): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) return _cachedToken.token;
  const base = getBaseUrl(creds.domain);
  const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = await res.json() as { code: number; tenant_access_token?: string; expire?: number; msg?: string };
  if (data.code !== 0 || !data.tenant_access_token) throw new Error(`Failed to get fsopen token: ${data.msg ?? `code ${data.code}`}`);
  _cachedToken = { token: data.tenant_access_token, expiresAt: Date.now() + ((data.expire ?? 7200) - 300) * 1000 };
  return _cachedToken.token;
}

interface ApiMenuBehavior {
  type: "target" | "event_key" | "send_message";
  target?: { common_url: string; ios_url?: string; android_url?: string; pc_url?: string; web_url?: string };
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
  bot_menu: { bot_menu_items: ApiMenuItem[] };
}

function behaviorToApi(b: BotMenuBehavior): ApiMenuBehavior {
  const api: ApiMenuBehavior = { type: b.type };
  if (b.type === "target" && b.url) api.target = { common_url: b.url };
  if (b.type === "event_key" && b.eventKey) api.event_key = b.eventKey;
  if (b.isPrimary != null) api.is_primary = b.isPrimary;
  return api;
}

function iconToApi(icon: BotMenuItemConfig["icon"]): ApiMenuIcon | undefined {
  if (!icon) return undefined;
  const api: ApiMenuIcon = {};
  if (icon.token) api.ud_icon = { token: icon.token, color: icon.color };
  if (icon.fileKey) api.file_key = icon.fileKey;
  return Object.keys(api).length > 0 ? api : undefined;
}

function menuItemToApi(item: BotMenuItemConfig): ApiMenuItem {
  const api: ApiMenuItem = { name: item.name };
  api.i18n_name = item.i18nName ?? { en_us: item.name };
  if (item.icon) api.icon = iconToApi(item.icon);
  if (item.tag) api.tag = item.tag;
  if (item.children?.length) api.children = item.children.map(menuItemToApi);
  else if (item.behaviors?.length) api.behaviors = item.behaviors.map(behaviorToApi);
  return api;
}

export class MenuSyncer {
  private _creds: FsopenCredentials;
  private _menuApi: string;

  constructor(creds: FsopenCredentials) {
    this._creds = creds;
    this._menuApi = `${getBaseUrl(creds.domain)}/bot/v3/bot_menu`;
  }

  async syncAll(config: BotMenuConfig, triggerUserIds?: string[]): Promise<void> {
    if (!config.default?.length && !config.users?.length) { log.info("no bot_menu config found, skipping sync"); return; }
    const userMenuMap = new Map<string, BotMenuItemConfig[]>();
    if (config.default?.length && triggerUserIds?.length) {
      for (const uid of triggerUserIds) userMenuMap.set(uid, config.default);
    }
    if (config.users) {
      for (const user of config.users) userMenuMap.set(user.userId, user.items);
    }
    for (const [userId, items] of userMenuMap) {
      await this._postMenu({ user_id: userId, bot_menu: { bot_menu_items: items.map(menuItemToApi) } });
      log.info(`synced menu for ${userId} (${items.length} items)`);
    }
  }

  async getMenu(userId?: string, userIdType = "open_id"): Promise<any> {
    const token = await getFsopenToken(this._creds);
    const params = new URLSearchParams();
    if (userId) { params.set("user_id", userId); params.set("user_id_type", userIdType); }
    const url = `${this._menuApi}${params.toString() ? `?${params}` : ""}`;
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if ((data as any).code !== 0) log.warn(`GET menu failed: ${(data as any).msg} (code ${(data as any).code})`);
    return data;
  }

  async deleteUserMenu(userId: string, userIdType = "open_id"): Promise<void> {
    const token = await getFsopenToken(this._creds);
    const url = `${this._menuApi}?${new URLSearchParams({ user_id_type: userIdType })}`;
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ user_id: userId }) });
    const data = await res.json();
    if ((data as any).code !== 0) log.warn(`DELETE menu for ${userId} failed: ${(data as any).msg} (code ${(data as any).code})`);
  }

  private async _postMenu(payload: ApiMenuPayload, userIdType = "open_id"): Promise<void> {
    const token = await getFsopenToken(this._creds);
    const url = `${this._menuApi}?${new URLSearchParams({ user_id_type: userIdType })}`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if ((data as any).code !== 0) { log.warn(`POST menu failed: ${(data as any).msg} (code ${(data as any).code})`); throw new Error(`Bot menu sync failed: ${(data as any).msg}`); }
  }
}
