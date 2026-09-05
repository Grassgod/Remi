/**
 * Bot Menu Syncer — sync menu config to Feishu bot_menu API.
 *
 * Supports both global default menus and per-user personalized menus (千人千面).
 */

import type {
  BotMenuBehavior,
  BotMenuItemConfig,
  BotMenuPublishResult,
  ResolvedBotMenuConfig,
} from "@multiremi/contracts/types.js";
import { createLogger } from "@shared/logger.js";

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

/**
 * Ceiling for a single call to the Feishu open API.
 *
 * `fetch` has no default timeout, so without this a stalled gateway hangs the
 * publish forever: the control plane eventually expires the request and the
 * operator only ever sees "did not finish in time" instead of the real fault.
 * Publishing happens on a human's button press, so failing loudly after 20s
 * beats waiting indefinitely.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One Feishu API call, bounded in time and reported with the endpoint that
 * failed. Gateways in front of the open API answer 5xx with HTML or an empty
 * body, which `res.json()` alone surfaces as an opaque parse error.
 */
async function callFsopenApi(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let res: Response;
    let body: string;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
      body = await res.text();
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms (${url})`);
      throw new Error(`${label} could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error(`${label} returned HTTP ${res.status} with a non-JSON body: ${body.slice(0, 200) || "<empty>"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function apiCode(data: Record<string, unknown>): number | undefined {
  return typeof data.code === "number" ? data.code : undefined;
}

function apiMessage(data: Record<string, unknown>): string {
  if (typeof data.msg === "string" && data.msg) return data.msg;
  return `code ${apiCode(data) ?? "unknown"}`;
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
  private _tokenApi: string;
  private _timeoutMs: number;
  // Per-instance, not module-global: a workspace that rotates its App Secret
  // gets a fresh MenuSyncer, and a shared cache would hand it the old tenant
  // token — or another workspace's — until the two-hour expiry.
  private _cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(creds: FsopenCredentials, options: { requestTimeoutMs?: number } = {}) {
    this._creds = creds;
    const base = getBaseUrl(creds.domain);
    this._menuApi = `${base}/bot/v3/bot_menu`;
    this._tokenApi = `${base}/auth/v3/tenant_access_token/internal`;
    this._timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async syncAll(config: ResolvedBotMenuConfig, options: { dryRun?: boolean } = {}): Promise<BotMenuPublishResult> {
    const defaultPublished = Boolean(config.default?.length);
    const users = config.users ?? [];
    if (!defaultPublished && users.length === 0) {
      log.info("no bot_menu config found, skipping sync");
      return { dryRun: Boolean(options.dryRun), defaultPublished: false, userMenuCount: 0 };
    }
    if (!options.dryRun && config.default?.length) {
      await this._postMenu({ bot_menu: { bot_menu_items: config.default.map(menuItemToApi) } });
      log.info(`synced default menu (${config.default.length} items)`);
    }
    if (!options.dryRun) {
      for (const user of users) {
        await this._postMenu(
          { user_id: user.userId, bot_menu: { bot_menu_items: user.items.map(menuItemToApi) } },
          user.userIdType,
        );
        log.info(`synced personalized menu (${user.items.length} items)`);
      }
    }
    return { dryRun: Boolean(options.dryRun), defaultPublished, userMenuCount: users.length };
  }

  async getMenu(userId?: string, userIdType = "open_id"): Promise<any> {
    const token = await this._token();
    const params = new URLSearchParams();
    if (userId) { params.set("user_id", userId); params.set("user_id_type", userIdType); }
    const url = `${this._menuApi}${params.toString() ? `?${params}` : ""}`;
    const data = await callFsopenApi(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }, "GET bot menu", this._timeoutMs);
    if (apiCode(data) !== 0) log.warn(`GET menu failed: ${apiMessage(data)}`);
    return data;
  }

  async deleteUserMenu(userId: string, userIdType = "open_id"): Promise<void> {
    const token = await this._token();
    const url = `${this._menuApi}?${new URLSearchParams({ user_id_type: userIdType })}`;
    const data = await callFsopenApi(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ user_id: userId }),
    }, "DELETE bot menu", this._timeoutMs);
    if (apiCode(data) !== 0) log.warn(`DELETE menu for ${userId} failed: ${apiMessage(data)}`);
  }

  private async _token(): Promise<string> {
    if (this._cachedToken && Date.now() < this._cachedToken.expiresAt) return this._cachedToken.token;
    const data = await callFsopenApi(this._tokenApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this._creds.appId, app_secret: this._creds.appSecret }),
    }, "Feishu tenant access token", this._timeoutMs);
    const token = typeof data.tenant_access_token === "string" ? data.tenant_access_token : "";
    if (apiCode(data) !== 0 || !token) throw new Error(`Failed to get fsopen token: ${apiMessage(data)}`);
    const expire = typeof data.expire === "number" ? data.expire : 7200;
    this._cachedToken = { token, expiresAt: Date.now() + (expire - 300) * 1000 };
    return token;
  }

  private async _postMenu(payload: ApiMenuPayload, userIdType = "open_id"): Promise<void> {
    const token = await this._token();
    const url = `${this._menuApi}?${new URLSearchParams({ user_id_type: userIdType })}`;
    const data = await callFsopenApi(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    }, "POST bot menu", this._timeoutMs);
    if (apiCode(data) !== 0) {
      log.warn(`POST menu failed: ${apiMessage(data)}`);
      throw new Error(`Bot menu sync failed: ${apiMessage(data)}`);
    }
  }
}
