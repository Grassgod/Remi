/**
 * SsoProvider — base interface every SSO plugin implements.
 *
 * A plugin is a class that knows how to:
 *   1. build the authorize redirect URL
 *   2. exchange the callback code for verified user claims
 *   3. (optionally) build a logout URL
 *
 * Provider instances are created per row in the `sso_providers` DB table.
 * The `config` JSON of that row is passed to the plugin's constructor.
 */

export interface AuthorizeParams {
  state: string;
  nonce: string;
  redirectUri: string;
}

export interface AuthorizedClaims {
  /** Stable IdP-side subject id (REQUIRED). */
  sub: string;
  /** Login name preferred for username (e.g. ByteDance "username" claim or email prefix). */
  username: string;
  email: string;
  name?: string;
  nickname?: string;
  picture?: string;
  /** Free-form additional claims to persist (employee_id, tenant_alias, ...). */
  extra?: Record<string, unknown>;
}

export interface SsoProvider {
  /** Stable plugin type name (e.g. "bytedance-oidc"). Matches the DB `type` column. */
  readonly type: string;

  /** Build the SSO authorize URL the browser should redirect to. */
  buildAuthorizeUrl(p: AuthorizeParams): Promise<string>;

  /**
   * Exchange the authorization code for an ID token and return verified user claims.
   * Implementations are responsible for:
   *   - hitting the token endpoint
   *   - verifying the ID token signature/nonce/exp/iss/aud
   *   - (optionally) calling userinfo for extra fields
   */
  handleCallback(p: {
    code: string;
    redirectUri: string;
    nonce: string;
  }): Promise<AuthorizedClaims>;

  /** Optional: build IdP logout URL. Return null if unsupported. */
  buildLogoutUrl?(p: {
    postLogoutRedirectUri: string;
    state: string;
  }): Promise<string | null>;
}

/**
 * Factory: given the row's `config` JSON, construct a provider instance.
 * Plugins implement this to parse + validate their config.
 */
export type SsoProviderFactory = (config: Record<string, unknown>) => SsoProvider;

/**
 * Each plugin type also declares its config schema, so a future Admin UI
 * can render the right form. Optional but recommended.
 */
export interface ConfigField {
  name: string;
  label: string;
  type: "text" | "password" | "url" | "select" | "boolean" | "tags";
  required: boolean;
  default?: unknown;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface PluginTypeMeta {
  type: string;
  displayName: string;
  description: string;
  configSchema: ConfigField[];
}
