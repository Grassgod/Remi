/**
 * Feishu auth adapter — manages tenant_access_token and user_access_token.
 *
 * tenant_access_token: Fully automatic (app_id + app_secret → token).
 * user_access_token:   Requires initial OAuth, then auto-refreshes via refresh_token.
 *                      Can also be set statically via config.
 */

import type { AuthAdapter, TokenEntry, TokenStatus } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("1passport");

export interface FeishuAuthConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  /** Static user access token from config (optional). */
  userAccessToken?: string;
}

export class FeishuAuthAdapter implements AuthAdapter {
  readonly service = "feishu";
  private _tokens = new Map<string, TokenEntry>();
  private _config: FeishuAuthConfig;
  private _apiBase: string;
  private _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _onTokenChangeCb: (() => void) | null = null;

  constructor(config: FeishuAuthConfig) {
    this._config = config;
    this._apiBase = resolveApiBase(config.domain);

    // Static user token from config (treat as long-lived)
    if (config.userAccessToken) {
      this._tokens.set("user", {
        value: config.userAccessToken,
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      });
    }
  }

  // ── AuthAdapter interface ─────────────────────────────────

  async getToken(type = "tenant"): Promise<string> {
    const entry = this._tokens.get(type);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.value;
    }
    return this._refresh(type);
  }

  async checkAndRefresh(): Promise<void> {
    for (const [type, entry] of this._tokens) {
      if (Date.now() > entry.expiresAt - 10 * 60 * 1000) {
        try {
          await this._refresh(type);
        } catch (e) {
          log.error(`feishu/${type} proactive refresh failed:`, e);
        }
      }
    }
  }

  status(): TokenStatus[] {
    const result: TokenStatus[] = [];
    for (const [type, entry] of this._tokens) {
      result.push({
        service: this.service,
        type,
        valid: Date.now() < entry.expiresAt,
        expiresAt: entry.expiresAt,
        refreshable: type === "tenant" || !!entry.refreshToken,
      });
    }
    return result;
  }

  restoreTokens(tokens: Record<string, TokenEntry>): void {
    for (const [type, entry] of Object.entries(tokens)) {
      // Don't override static user token from config
      if (type === "user" && this._config.userAccessToken) continue;

      if (Date.now() < entry.expiresAt) {
        this._tokens.set(type, entry);
        this._scheduleRefresh(type);
        log.debug(
          `feishu/${type} token restored (expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s)`,
        );
      } else {
        log.info(`feishu/${type} persisted token expired, will refresh on demand`);
      }
    }
  }

  exportTokens(): Record<string, TokenEntry> {
    const result: Record<string, TokenEntry> = {};
    for (const [type, entry] of this._tokens) {
      // Don't persist static config tokens (no refresh needed)
      if (type === "user" && this._config.userAccessToken && !entry.refreshToken) continue;
      result[type] = { ...entry };
    }
    return result;
  }

  onTokenChange(cb: () => void): void {
    this._onTokenChangeCb = cb;
  }

  // ── Internal ──────────────────────────────────────────────

  private async _refresh(type: string): Promise<string> {
    switch (type) {
      case "tenant":
        return this._refreshTenant();
      case "user":
        return this._refreshUser();
      default:
        throw new Error(`feishu: unknown token type "${type}"`);
    }
  }

  private async _refreshTenant(): Promise<string> {
    const resp = await fetch(
      `${this._apiBase}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this._config.appId,
          app_secret: this._config.appSecret,
        }),
      },
    );

    const data = (await resp.json()) as {
      code: number;
      msg: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`tenant_access_token failed: ${data.msg}`);
    }

    const entry: TokenEntry = {
      value: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000 - 5 * 60 * 1000,
    };

    this._tokens.set("tenant", entry);
    this._scheduleRefresh("tenant");
    this._onTokenChangeCb?.();

    log.debug(
      `tenant token refreshed, expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s`,
    );
    return entry.value;
  }

  private async _refreshUser(): Promise<string> {
    const entry = this._tokens.get("user");

    // Static token without refresh capability
    if (entry && !entry.refreshToken) {
      if (Date.now() < entry.expiresAt) return entry.value;
      throw new Error(
        "user_access_token expired, no refresh_token. Re-authorize required.",
      );
    }

    if (!entry?.refreshToken) {
      throw new Error("No user token. Authorization required.");
    }

    if (entry.refreshExpiresAt && Date.now() >= entry.refreshExpiresAt) {
      throw new Error("refresh_token expired. Re-authorization required.");
    }

    // Need tenant token to call the refresh endpoint
    const appToken = await this.getToken("tenant");

    const resp = await fetch(
      `${this._apiBase}/authen/v1/refresh_access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: entry.refreshToken,
        }),
      },
    );

    const result = (await resp.json()) as {
      code: number;
      msg?: string;
      data?: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        refresh_expires_in: number;
      };
    };

    if (result.code !== 0 || !result.data) {
      throw new Error(
        `user token refresh failed: ${result.msg ?? `code ${result.code}`}`,
      );
    }

    const newEntry: TokenEntry = {
      value: result.data.access_token,
      expiresAt: Date.now() + result.data.expires_in * 1000 - 5 * 60 * 1000,
      refreshToken: result.data.refresh_token,
      refreshExpiresAt:
        Date.now() + result.data.refresh_expires_in * 1000,
    };

    this._tokens.set("user", newEntry);
    this._scheduleRefresh("user");
    this._onTokenChangeCb?.();

    log.info(
      `user token refreshed, expires in ${Math.round((newEntry.expiresAt - Date.now()) / 1000)}s`,
    );
    return newEntry.value;
  }

  private _scheduleRefresh(type: string): void {
    const old = this._refreshTimers.get(type);
    if (old) clearTimeout(old);

    const entry = this._tokens.get(type);
    if (!entry) return;

    const delay = Math.max(entry.expiresAt - Date.now() - 5 * 60 * 1000, 0);

    const timer = setTimeout(async () => {
      try {
        await this._refresh(type);
        log.info(`feishu/${type} auto-refreshed`);
      } catch (e) {
        log.error(`feishu/${type} auto-refresh failed:`, e);
      }
    }, delay);

    if (typeof timer.unref === "function") timer.unref();
    this._refreshTimers.set(type, timer);
    log.debug(`feishu/${type} refresh scheduled in ${Math.round(delay / 1000)}s`);
  }
}

/** Resolve Feishu API base URL from domain. */
function resolveApiBase(domain?: string): string {
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}
