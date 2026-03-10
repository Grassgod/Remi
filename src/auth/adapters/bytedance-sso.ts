/**
 * ByteDance SSO auth adapter — manages SSO access_token and ByteCloud JWT.
 *
 * access_token: Obtained via Device Code flow, auto-refreshed via refresh_token.
 * jwt:          Derived from access_token by exchanging with ByteCloud endpoint.
 *               Short-lived (~10min), cached and re-derived on demand.
 */

import type { AuthAdapter, TokenEntry, TokenStatus } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("1passport:bytedance-sso");

const DEFAULT_SSO_HOST = "https://sso.bytedance.com";
const DEFAULT_BYTECLOUD_HOST = "https://cloud.bytedance.net";
const DEFAULT_SCOPES = ["read", "ciam.device.read"];
const DEFAULT_CLIENT_ID = "cd1k8uzbde1i1aa1gy0f";

const DEVICE_CODE_ENDPOINT = "/oauth2/device/code";
const TOKEN_ENDPOINT = "/oauth2/access_token";
const JWT_ENDPOINT = "/auth/api/v1/jwt";

/** 10 minutes JWT cache TTL. */
const JWT_CACHE_TTL_MS = 10 * 60 * 1000;
/** Max polling attempts for device code flow. */
const MAX_POLL_ATTEMPTS = 120;

export interface ByteDanceSSOConfig {
  clientId?: string;
  ssoHost?: string;
  bytecloudHost?: string;
  scopes?: string[];
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export class ByteDanceSSOAdapter implements AuthAdapter {
  readonly service = "bytedance-sso";
  private _tokens = new Map<string, TokenEntry>();
  private _config: Required<ByteDanceSSOConfig>;
  private _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _onTokenChangeCb: (() => void) | null = null;

  constructor(config: ByteDanceSSOConfig) {
    this._config = {
      clientId: config.clientId ?? DEFAULT_CLIENT_ID,
      ssoHost: (config.ssoHost ?? DEFAULT_SSO_HOST).replace(/\/+$/, ""),
      bytecloudHost: (config.bytecloudHost ?? DEFAULT_BYTECLOUD_HOST).replace(/\/+$/, ""),
      scopes: config.scopes ?? DEFAULT_SCOPES,
    };
  }

  // ── AuthAdapter interface ─────────────────────────────────

  async getToken(type = "access"): Promise<string> {
    const entry = this._tokens.get(type);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.value;
    }

    if (type === "jwt") {
      return this._refreshJwt();
    }
    if (type === "access") {
      return this._refreshAccess();
    }
    throw new Error(`bytedance-sso: unknown token type "${type}"`);
  }

  async checkAndRefresh(): Promise<void> {
    // Proactively refresh access token 5 minutes before expiry
    const access = this._tokens.get("access");
    if (access && access.refreshToken && Date.now() > access.expiresAt - 5 * 60 * 1000) {
      try {
        await this._refreshAccess();
      } catch (e) {
        log.error("access token proactive refresh failed:", e);
      }
    }

    // Proactively refresh JWT 2 minutes before expiry
    const jwt = this._tokens.get("jwt");
    if (jwt && Date.now() > jwt.expiresAt - 2 * 60 * 1000) {
      try {
        await this._refreshJwt();
      } catch (e) {
        log.error("jwt proactive refresh failed:", e);
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
        refreshable: type === "access" ? !!entry.refreshToken : true,
      });
    }
    return result;
  }

  restoreTokens(tokens: Record<string, TokenEntry>): void {
    for (const [type, entry] of Object.entries(tokens)) {
      if (Date.now() < entry.expiresAt) {
        this._tokens.set(type, entry);
        if (type === "access") this._scheduleRefresh("access");
        log.debug(
          `bytedance-sso/${type} token restored (expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s)`,
        );
      } else if (type === "access" && entry.refreshToken) {
        // Expired but has refresh token — keep it for refresh attempt
        this._tokens.set(type, entry);
        log.info("bytedance-sso/access expired, will refresh on demand");
      } else {
        log.info(`bytedance-sso/${type} persisted token expired, discarding`);
      }
    }
  }

  exportTokens(): Record<string, TokenEntry> {
    const result: Record<string, TokenEntry> = {};
    for (const [type, entry] of this._tokens) {
      // Only persist access token (jwt is derived, short-lived)
      if (type === "access") {
        result[type] = { ...entry };
      }
    }
    return result;
  }

  onTokenChange(cb: () => void): void {
    this._onTokenChangeCb = cb;
  }

  // ── Device Code flow (for CLI / interactive login) ────────

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const url = `${this._config.ssoHost}${DEVICE_CODE_ENDPOINT}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this._config.clientId,
        scope: this._config.scopes.join(" "),
      }),
    });

    if (!resp.ok) {
      throw new Error(`Device code request failed: ${resp.status} ${resp.statusText}`);
    }
    return (await resp.json()) as DeviceCodeResponse;
  }

  async pollForToken(deviceCode: string, interval: number): Promise<void> {
    const url = `${this._config.ssoHost}${TOKEN_ENDPOINT}`;

    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, interval * 1000));

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this._config.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const data = (await resp.json()) as {
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };

      if (data.error === "authorization_pending") {
        continue;
      }

      if (data.error === "slow_down") {
        interval = Math.min(interval + 1, 10);
        continue;
      }

      if (data.error) {
        throw new Error(`Device code auth failed: ${data.error}`);
      }

      if (!data.access_token) {
        throw new Error("Device code auth failed: no access_token returned");
      }

      // Success — store tokens
      const entry: TokenEntry = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
      };
      if (data.refresh_token) {
        entry.refreshToken = data.refresh_token;
        // SSO refresh tokens typically last 30 days
        entry.refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      }

      this._tokens.set("access", entry);
      this._scheduleRefresh("access");
      this._onTokenChangeCb?.();

      log.info(
        `ByteDance SSO authenticated (expires in ${Math.round((entry.expiresAt - Date.now()) / 1000)}s)`,
      );
      return;
    }

    throw new Error("Device code auth timed out (user did not authorize)");
  }

  // ── Internal ──────────────────────────────────────────────

  private async _refreshAccess(): Promise<string> {
    const entry = this._tokens.get("access");
    if (!entry?.refreshToken) {
      throw new Error(
        "ByteDance SSO: no refresh_token. Run `bun run src/main.ts auth bytedance-sso` to re-authenticate.",
      );
    }

    if (entry.refreshExpiresAt && Date.now() >= entry.refreshExpiresAt) {
      throw new Error("ByteDance SSO: refresh_token expired. Re-authentication required.");
    }

    const url = `${this._config.ssoHost}${TOKEN_ENDPOINT}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this._config.clientId,
        grant_type: "refresh_token",
        refresh_token: entry.refreshToken,
      }),
    });

    const data = (await resp.json()) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (data.error || !data.access_token) {
      // Clear invalid tokens
      this._tokens.delete("access");
      this._tokens.delete("jwt");
      this._onTokenChangeCb?.();
      throw new Error(`ByteDance SSO refresh failed: ${data.error ?? "no access_token"}`);
    }

    const newEntry: TokenEntry = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
      refreshToken: data.refresh_token ?? entry.refreshToken,
      refreshExpiresAt: entry.refreshExpiresAt,
    };

    this._tokens.set("access", newEntry);
    this._scheduleRefresh("access");
    this._onTokenChangeCb?.();

    log.info(
      `bytedance-sso/access refreshed (expires in ${Math.round((newEntry.expiresAt - Date.now()) / 1000)}s)`,
    );
    return newEntry.value;
  }

  private async _refreshJwt(): Promise<string> {
    // Need a valid access token first
    const accessToken = await this.getToken("access");

    const url =
      `${this._config.bytecloudHost}${JWT_ENDPOINT}` +
      `?sso_access_token=${encodeURIComponent(accessToken)}` +
      `&sso_client_id=${encodeURIComponent(this._config.clientId)}`;

    const resp = await fetch(url, {
      headers: { accept: "application/json" },
    });

    // Extract JWT from response header or body
    const jwt = this._extractJwt(resp, await resp.text());
    if (!jwt) {
      throw new Error("ByteCloud JWT exchange failed: no JWT in response");
    }

    const entry: TokenEntry = {
      value: jwt,
      expiresAt: Date.now() + JWT_CACHE_TTL_MS,
    };

    this._tokens.set("jwt", entry);
    this._onTokenChangeCb?.();

    log.debug("bytedance-sso/jwt refreshed");
    return jwt;
  }

  private _extractJwt(resp: Response, body: string): string | null {
    // 1. Check response header
    const headerJwt = resp.headers.get("X-Jwt-Token") ?? resp.headers.get("x-jwt-token");
    if (headerJwt) return headerJwt;

    // 2. Parse body
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.jwt === "string") return parsed.jwt;
      if (typeof parsed.token === "string") return parsed.token;
      // Nested data
      const data = parsed.data as Record<string, unknown> | undefined;
      if (data) {
        if (typeof data.jwt === "string") return data.jwt;
        if (typeof data.token === "string") return data.token;
      }
    } catch {
      // Not JSON
    }
    return null;
  }

  private _scheduleRefresh(type: string): void {
    const old = this._refreshTimers.get(type);
    if (old) clearTimeout(old);

    const entry = this._tokens.get(type);
    if (!entry || !entry.refreshToken) return;

    const delay = Math.max(entry.expiresAt - Date.now() - 5 * 60 * 1000, 0);

    const timer = setTimeout(async () => {
      try {
        await this._refreshAccess();
        log.info("bytedance-sso/access auto-refreshed");
      } catch (e) {
        log.error("bytedance-sso/access auto-refresh failed:", e);
      }
    }, delay);

    if (typeof timer.unref === "function") timer.unref();
    this._refreshTimers.set(type, timer);
    log.debug(`bytedance-sso/${type} refresh scheduled in ${Math.round(delay / 1000)}s`);
  }
}
