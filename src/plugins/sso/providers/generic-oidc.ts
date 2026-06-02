/**
 * Generic OIDC plugin — covers any OIDC-compliant IdP
 * (Google, Auth0, Keycloak, custom).
 */

import type {
  AuthorizeParams,
  AuthorizedClaims,
  SsoProvider,
  PluginTypeMeta,
} from "./base.js";
import { OidcCore } from "./oidc-core.js";

interface GenericConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Optional override for which claim becomes the Remi username. Default: "preferred_username", fallback to email prefix. */
  usernameClaim?: string;
}

export class GenericOidcProvider implements SsoProvider {
  readonly type = "generic-oidc";
  private _core: OidcCore;
  private _cfg: GenericConfig;

  constructor(config: Record<string, unknown>) {
    this._cfg = parseConfig(config);
    this._core = new OidcCore({
      issuer: this._cfg.issuer,
      clientId: this._cfg.clientId,
      clientSecret: this._cfg.clientSecret,
      scopes: this._cfg.scopes,
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

    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = await this._core.fetchUserInfo(tokens.access_token);
    } catch {
      /* non-fatal */
    }

    const merged = { ...userinfo, ...claims };
    const usernameClaim = this._cfg.usernameClaim ?? "preferred_username";
    const username =
      (merged[usernameClaim] as string | undefined) ??
      String(merged.email ?? "").split("@")[0];

    return {
      sub: String(merged.sub),
      username,
      email: String(merged.email ?? ""),
      name: (merged.name as string) ?? undefined,
      nickname: (merged.nickname as string) ?? undefined,
      picture: (merged.picture as string) ?? undefined,
      extra: merged,
    };
  }

  buildLogoutUrl(p: {
    postLogoutRedirectUri: string;
    state: string;
  }): Promise<string | null> {
    return this._core.buildLogoutUrl(p);
  }
}

function parseConfig(raw: Record<string, unknown>): GenericConfig {
  const issuer = String(raw.issuer ?? "");
  const clientId = String(raw.client_id ?? raw.clientId ?? "");
  const clientSecret = String(raw.client_secret ?? raw.clientSecret ?? "");
  if (!issuer) throw new Error("generic-oidc: issuer required");
  if (!clientId) throw new Error("generic-oidc: client_id required");
  if (!clientSecret) throw new Error("generic-oidc: client_secret required");
  return {
    issuer,
    clientId,
    clientSecret,
    scopes: (raw.scopes as string[]) ?? ["openid", "profile", "email"],
    usernameClaim: (raw.username_claim as string) ?? undefined,
  };
}

export const GENERIC_OIDC_META: PluginTypeMeta = {
  type: "generic-oidc",
  displayName: "OpenID Connect (Generic)",
  description: "Any OIDC-compliant IdP (Google, Auth0, Keycloak, custom).",
  configSchema: [
    { name: "issuer", label: "Issuer URL", type: "url", required: true, description: "OIDC discovery base URL" },
    { name: "client_id", label: "Client ID", type: "text", required: true },
    { name: "client_secret", label: "Client Secret", type: "password", required: true },
    { name: "scopes", label: "Scopes", type: "tags", required: false, default: ["openid", "profile", "email"] },
    { name: "username_claim", label: "Username claim", type: "text", required: false, default: "preferred_username", description: "Which claim becomes the Remi username. Falls back to email prefix." },
  ],
};
