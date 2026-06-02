/**
 * Dev provider — local-only fake SSO for development.
 *
 * Skips any external IdP. buildAuthorizeUrl bounces the browser
 * straight to our callback with a generated code; handleCallback
 * returns a fixed dev user.
 *
 * SECURITY:
 *   - This provider must NEVER be enabled in production.
 *   - The factory refuses to construct when NODE_ENV=production unless
 *     config.allowInProduction === true (escape hatch for testing).
 *   - When enabled, anyone reaching /api/auth/sso/dev/login becomes logged in.
 *     Only run on machines you fully control.
 */

import type {
  AuthorizeParams,
  AuthorizedClaims,
  SsoProvider,
  PluginTypeMeta,
} from "./base.js";

interface DevConfig {
  username?: string;
  email?: string;
  name?: string;
  nickname?: string;
  picture?: string;
  allowInProduction?: boolean;
}

export class DevProvider implements SsoProvider {
  readonly type = "dev";

  constructor(private readonly _cfg: DevConfig) {
    if (
      process.env.NODE_ENV === "production" &&
      !_cfg.allowInProduction
    ) {
      throw new Error(
        "dev provider: refusing to instantiate in production " +
          "(set allow_in_production=true in config to override, NOT recommended)",
      );
    }
  }

  async buildAuthorizeUrl(p: AuthorizeParams): Promise<string> {
    // Bounce straight back to our own callback with a synthetic code.
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", `dev-${p.state}`);
    u.searchParams.set("state", p.state);
    return u.toString();
  }

  async handleCallback(_p: {
    code: string;
    redirectUri: string;
    nonce: string;
  }): Promise<AuthorizedClaims> {
    const username = this._cfg.username ?? "dev";
    return {
      sub: `dev-${username}`,
      username,
      email: this._cfg.email ?? `${username}@localhost`,
      name: this._cfg.name ?? "Dev User",
      nickname: this._cfg.nickname ?? "本地开发",
      picture: this._cfg.picture ?? undefined,
      extra: {
        tenant_alias: "dev",
        operator_type: "DEV",
      },
    };
  }

  buildLogoutUrl(): Promise<string | null> {
    // No external session — caller just clears the cookie.
    return Promise.resolve(null);
  }
}

export const DEV_PROVIDER_META: PluginTypeMeta = {
  type: "dev",
  displayName: "Dev (Local fake login)",
  description:
    "Local-only fake SSO. Refuses to instantiate when NODE_ENV=production.",
  configSchema: [
    { name: "username", label: "Username", type: "text", required: false, default: "dev" },
    { name: "email", label: "Email", type: "text", required: false, default: "dev@localhost" },
    { name: "name", label: "Display name", type: "text", required: false, default: "Dev User" },
    { name: "nickname", label: "Nickname", type: "text", required: false, default: "本地开发" },
    { name: "allow_in_production", label: "Allow in production", type: "boolean", required: false, default: false, description: "DANGEROUS. Leave off." },
  ],
};
