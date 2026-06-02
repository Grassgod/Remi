/**
 * ByteDance OIDC plugin (built-in).
 *
 * Pre-configured for sso.bytedance.com but lets users override issuer
 * if they're on TTP/i18n environments.
 */

import type {
  AuthorizeParams,
  AuthorizedClaims,
  SsoProvider,
  PluginTypeMeta,
} from "./base.js";
import { OidcCore } from "./oidc-core.js";

interface BytedanceConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

const DEFAULTS = {
  issuer: "https://sso.bytedance.com",
  scopes: ["openid", "profile", "email"],
};

export class BytedanceOidcProvider implements SsoProvider {
  readonly type = "bytedance-oidc";
  private _core: OidcCore;

  constructor(config: Record<string, unknown>) {
    const cfg = parseConfig(config);
    this._core = new OidcCore({
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      scopes: cfg.scopes,
    });
  }

  buildAuthorizeUrl(p: AuthorizeParams): Promise<string> {
    return this._core.buildAuthorizeUrl(p);
  }

  async handleCallback(p: {
    code: string;
    redirectUri: string;
    nonce: string;
  }): Promise<AuthorizedClaims> {
    const tokens = await this._core.exchangeCode(p.code, p.redirectUri);
    const claims = await this._core.verifyIdToken(tokens.id_token, p.nonce);

    // ByteDance ID token usually carries `username`, but call userinfo
    // as a safety net for `nickname` / `picture` / `employee_id` etc.
    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = await this._core.fetchUserInfo(tokens.access_token);
    } catch {
      /* non-fatal */
    }

    const merged = { ...userinfo, ...claims };
    const username =
      (merged.username as string | undefined) ??
      String(merged.email ?? "").split("@")[0];

    return {
      sub: String(merged.sub),
      username,
      email: String(merged.email ?? ""),
      name: (merged.name as string) ?? undefined,
      nickname: (merged.nickname as string) ?? undefined,
      picture: (merged.picture as string) ?? undefined,
      extra: {
        employee_id: merged.employee_id,
        employee_number: merged.employee_number,
        tenant_alias: merged.tenant_alias,
        operator_type: merged.operator_type,
      },
    };
  }

  buildLogoutUrl(p: {
    postLogoutRedirectUri: string;
    state: string;
  }): Promise<string | null> {
    return this._core.buildLogoutUrl(p);
  }
}

function parseConfig(raw: Record<string, unknown>): BytedanceConfig {
  const clientId = String(raw.client_id ?? raw.clientId ?? "");
  const clientSecret = String(raw.client_secret ?? raw.clientSecret ?? "");
  if (!clientId) throw new Error("bytedance-oidc: client_id required");
  if (!clientSecret) throw new Error("bytedance-oidc: client_secret required");
  return {
    issuer: String(raw.issuer ?? DEFAULTS.issuer),
    clientId,
    clientSecret,
    scopes: (raw.scopes as string[]) ?? DEFAULTS.scopes,
  };
}

export const BYTEDANCE_OIDC_META: PluginTypeMeta = {
  type: "bytedance-oidc",
  displayName: "ByteDance SSO",
  description: "ByteDance internal SSO (sso.bytedance.com) via OIDC.",
  configSchema: [
    { name: "issuer", label: "Issuer", type: "url", required: false, default: DEFAULTS.issuer, description: "OIDC issuer URL" },
    { name: "client_id", label: "Client ID", type: "text", required: true },
    { name: "client_secret", label: "Client Secret", type: "password", required: true },
    { name: "scopes", label: "Scopes", type: "tags", required: false, default: DEFAULTS.scopes },
  ],
};
