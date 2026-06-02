/**
 * OidcCore — shared OIDC implementation used by both bytedance-oidc
 * and generic-oidc plugins. Pure fetch, no external deps.
 *
 * Handles:
 *   - discovery (.well-known/openid-configuration)
 *   - JWKS fetch + cache (auto-refresh on kid miss)
 *   - authorize URL building
 *   - code → token exchange (client_secret_post)
 *   - ID token JWT verification (RS256)
 *   - userinfo fetch
 *   - logout URL
 */

import { createLogger } from "../../../logger.js";

const log = createLogger("oidc-core");
const JWKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Default upstream timeout for IdP requests (discovery / token / userinfo / jwks). */
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
/** Allowed clock skew between Remi and the IdP, in seconds. */
const CLOCK_SKEW_SEC = 60;

/** Fetch wrapper that always sets a timeout to avoid hanging the request. */
async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // Re-use caller's signal if provided, else build a fresh timeout signal.
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  return fetch(input, { ...init, signal });
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
  jwks_uri: string;
}

export interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface OidcCoreConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export class OidcCore {
  private _discovery: OidcDiscovery | null = null;
  private _discoveryInflight: Promise<OidcDiscovery> | null = null;
  private _jwks: { keys: JsonWebKey[] } | null = null;
  private _jwksFetchedAt = 0;
  private _jwksInflight: Promise<void> | null = null;
  private _keyCache = new Map<string, CryptoKey>();

  constructor(private readonly _cfg: OidcCoreConfig) {
    if (!_cfg.issuer) throw new Error("oidc: issuer required");
    if (!_cfg.clientId) throw new Error("oidc: clientId required");
    if (!_cfg.clientSecret) throw new Error("oidc: clientSecret required");
  }

  async discovery(): Promise<OidcDiscovery> {
    if (this._discovery) return this._discovery;
    // Dedupe: if a fetch is already in flight, return the same promise so
    // concurrent callers don't bombard the IdP.
    if (this._discoveryInflight) return this._discoveryInflight;

    const url = `${this._cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    log.info(`fetching OIDC discovery: ${url}`);
    this._discoveryInflight = (async () => {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`discovery fetch failed: ${res.status}`);
        const doc = (await res.json()) as Partial<OidcDiscovery>;
        if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
          throw new Error(`discovery doc missing required fields: ${JSON.stringify(doc)}`);
        }
        this._discovery = doc as OidcDiscovery;
        return this._discovery;
      } finally {
        this._discoveryInflight = null;
      }
    })();
    return this._discoveryInflight;
  }

  async buildAuthorizeUrl(p: {
    state: string;
    nonce: string;
    redirectUri: string;
  }): Promise<string> {
    const disc = await this.discovery();
    const u = new URL(disc.authorization_endpoint);
    u.searchParams.set("client_id", this._cfg.clientId);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", this._cfg.scopes.join(" "));
    u.searchParams.set("state", p.state);
    u.searchParams.set("nonce", p.nonce);
    return u.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<OidcTokenResponse> {
    const disc = await this.discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this._cfg.clientId,
      client_secret: this._cfg.clientSecret,
    });
    const res = await fetchWithTimeout(disc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`token exchange failed (${res.status}): ${text}`);
    }
    const body_ = (await res.json()) as Partial<OidcTokenResponse>;
    if (typeof body_.access_token !== "string" || typeof body_.id_token !== "string") {
      throw new Error(
        `malformed token response: missing access_token/id_token (got keys: ${Object.keys(body_).join(",")})`,
      );
    }
    return body_ as OidcTokenResponse;
  }

  async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<Record<string, unknown>> {
    const [hB64, pB64, sB64] = idToken.split(".");
    if (!hB64 || !pB64 || !sB64) throw new Error("invalid JWT format");

    const header = JSON.parse(b64uToStr(hB64)) as {
      alg: string;
      kid?: string;
    };
    const payload = JSON.parse(b64uToStr(pB64)) as Record<string, unknown>;

    if (header.alg !== "RS256") {
      throw new Error(`unsupported JWT alg: ${header.alg}`);
    }

    let key = await this._findKey(header.kid);
    if (!key) {
      await this._refreshJwks();
      key = await this._findKey(header.kid);
      if (!key) throw new Error(`JWK not found for kid: ${header.kid}`);
    }

    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64uBuffer(sB64),
      new TextEncoder().encode(`${hB64}.${pB64}`),
    );
    if (!valid) throw new Error("JWT signature invalid");

    const disc = await this.discovery();
    if (payload.iss !== disc.issuer) {
      throw new Error(`iss mismatch: ${payload.iss}`);
    }
    const aud = payload.aud;
    const audOk =
      aud === this._cfg.clientId ||
      (Array.isArray(aud) && aud.includes(this._cfg.clientId));
    if (!audOk) throw new Error(`aud mismatch: ${JSON.stringify(aud)}`);

    // Time-based claims (RFC 7519 §4.1.4-6). Allow a small clock skew.
    const nowSec = Math.floor(Date.now() / 1000);

    const exp = Number(payload.exp);
    if (!Number.isFinite(exp)) throw new Error("JWT missing exp");
    if (exp + CLOCK_SKEW_SEC < nowSec) throw new Error("JWT expired");

    if (payload.nbf !== undefined) {
      const nbf = Number(payload.nbf);
      if (Number.isFinite(nbf) && nbf - CLOCK_SKEW_SEC > nowSec) {
        throw new Error("JWT not yet valid (nbf)");
      }
    }

    if (payload.iat !== undefined) {
      const iat = Number(payload.iat);
      if (Number.isFinite(iat) && iat - CLOCK_SKEW_SEC > nowSec) {
        throw new Error("JWT issued in the future (iat)");
      }
    }

    if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch");

    return payload;
  }

  async fetchUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const disc = await this.discovery();
    const res = await fetchWithTimeout(disc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`userinfo fetch failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async buildLogoutUrl(p: {
    postLogoutRedirectUri: string;
    state: string;
  }): Promise<string | null> {
    const disc = await this.discovery();
    if (!disc.end_session_endpoint) return null;
    const u = new URL(disc.end_session_endpoint);
    u.searchParams.set("client_id", this._cfg.clientId);
    u.searchParams.set("post_logout_redirect_uri", p.postLogoutRedirectUri);
    u.searchParams.set("state", p.state);
    return u.toString();
  }

  // ── internals ──

  private async _refreshJwks(): Promise<void> {
    const now = Date.now();
    if (this._jwks && now - this._jwksFetchedAt < JWKS_CACHE_TTL_MS) {
      return;
    }
    // Dedupe in-flight refresh
    if (this._jwksInflight) return this._jwksInflight;

    this._jwksInflight = (async () => {
      try {
        const disc = await this.discovery();
        const res = await fetchWithTimeout(disc.jwks_uri);
        if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
        const jwks = (await res.json()) as { keys?: JsonWebKey[] };
        if (!Array.isArray(jwks.keys)) {
          throw new Error("jwks response missing 'keys' array");
        }
        this._jwks = jwks as { keys: JsonWebKey[] };
        this._jwksFetchedAt = Date.now();
        this._keyCache.clear();
      } finally {
        this._jwksInflight = null;
      }
    })();
    return this._jwksInflight;
  }

  private async _findKey(kid?: string): Promise<CryptoKey | null> {
    if (kid && this._keyCache.has(kid)) return this._keyCache.get(kid)!;
    if (!this._jwks) await this._refreshJwks();
    const jwks = this._jwks!;
    const jwk = kid
      ? jwks.keys.find((k) => (k as { kid?: string }).kid === kid)
      : jwks.keys[0];
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (kid) this._keyCache.set(kid, key);
    return key;
  }
}

function b64u(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = p.length % 4 ? 4 - (p.length % 4) : 0;
  const bin = atob(p + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uBuffer(s: string): ArrayBuffer {
  const bytes = b64u(s);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function b64uToStr(s: string): string {
  return new TextDecoder().decode(b64u(s));
}
