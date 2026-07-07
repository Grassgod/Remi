/**
 * SSO HTTP handlers — provider-aware routes.
 *
 *   GET  /api/auth/sso/providers                — list enabled providers (for login page)
 *   GET  /api/auth/sso/:providerId/login        — start auth code flow
 *   GET  /api/auth/sso/:providerId/callback     — exchange code, create session
 *   POST /api/auth/sso/logout                   — clear session
 *   GET  /api/auth/me                           — current user + ssoConfigured
 *   GET  /api/v1/system/host-info               — local IPs/hostname (for whitelist help)
 */

import { networkInterfaces, hostname } from "node:os";
import type { Hono } from "hono";
import { createLogger } from "@shared/logger.js";
import { listProviders, getProvider } from "../db/providers.js";
import { getSettings } from "../db/settings.js";
import {
  upsertUser,
  createSession,
  deleteSession,
  getSession,
  getUserByUsername,
  type OidcClaims,
  type UserRole,
} from "../db/users.js";
import { appendAccessLog } from "../db/access-log.js";
import {
  createOAuthState,
  consumeOAuthState,
  sweepExpiredOAuthStates,
} from "../db/oauth-states.js";
import { SsoProviderRegistry } from "../providers/registry.js";
import { buildCookie, clearCookie, readCookie } from "./cookies.js";
import {
  resolveBaseUrl,
  resolveCallbackUrl,
} from "./host-resolver.js";

const log = createLogger("sso");

/**
 * Strip ASCII control chars (incl. CR/LF) and trim — prevents log
 * injection / fake log lines when user-controlled strings get embedded.
 */
function safeLogValue(v: unknown, maxLen = 200): string {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, maxLen);
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** Role hierarchy: admin > member. */
function checkRole(actual: UserRole, required: UserRole): boolean {
  if (required === "member") return actual === "admin" || actual === "member";
  if (required === "admin") return actual === "admin";
  return false;
}

/** Opaque random token for OAuth state/nonce — uses Web Crypto's UUIDv4. */
function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export interface SsoHandlerOpts {
  /** Bootstrap admin email list. */
  adminEmails: string[];
}

export function registerSsoHandlers(
  app: Hono,
  registry: SsoProviderRegistry,
  opts: SsoHandlerOpts = { adminEmails: [] },
): void {
  // ── Login screen support: list enabled providers ──────────────
  app.get("/api/auth/sso/providers", (c) => {
    const providers = listProviders({ enabledOnly: true });
    return c.json({
      providers: providers.map((p) => ({
        id: p.id,
        type: p.type,
        name: p.name,
        icon: p.icon,
      })),
    });
  });

  // ── Start login ───────────────────────────────────────────────
  app.get("/api/auth/sso/:providerId/login", async (c) => {
    const providerId = c.req.param("providerId");
    const row = getProvider(providerId);
    if (!row || !row.enabled) {
      return c.json({ error: `provider not found or disabled: ${providerId}` }, 404);
    }
    if (!registry.hasType(row.type)) {
      return c.json({ error: `plugin type not loaded: ${row.type}` }, 500);
    }

    try { sweepExpiredOAuthStates(); } catch { /* best-effort */ }
    const state = randomToken();
    const nonce = randomToken();
    const next = c.req.query("next") ?? "/";
    createOAuthState({
      providerId,
      state,
      nonce,
      next,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    try {
      const provider = registry.get(providerId, row.type, row.config);
      const redirectUri = resolveCallbackUrl(c, providerId);
      const url = await provider.buildAuthorizeUrl({ state, nonce, redirectUri });
      log.info(
        `SSO login [${safeLogValue(providerId, 40)}] → ${url.slice(0, 80)}... next=${safeLogValue(next, 100)}`,
      );
      return c.redirect(url);
    } catch (e) {
      log.error("buildAuthorizeUrl failed", e);
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
    }
  });

  // ── Callback ──────────────────────────────────────────────────
  app.get("/api/auth/sso/:providerId/callback", async (c) => {
    const providerId = c.req.param("providerId");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");

    if (err) {
      log.warn(
        `SSO callback error: ${safeLogValue(err)} ${safeLogValue(c.req.query("error_description"))}`,
      );
      return c.json({ error: `SSO returned error: ${safeLogValue(err)}` }, 400);
    }
    if (!code || !state) return c.json({ error: "missing code or state" }, 400);

    const saved = consumeOAuthState(state);
    if (!saved) {
      return c.json({ error: "invalid or expired state" }, 400);
    }
    if (saved.providerId !== providerId) {
      return c.json({ error: "providerId mismatch with state" }, 400);
    }

    const row = getProvider(providerId);
    if (!row) return c.json({ error: "provider gone" }, 404);

    let claims;
    try {
      const provider = registry.get(providerId, row.type, row.config);
      claims = await provider.handleCallback({
        code,
        redirectUri: resolveCallbackUrl(c, providerId),
        nonce: saved.nonce,
      });
    } catch (e) {
      log.error("handleCallback failed", e);
      return c.json({ error: "authentication failed: " + String(e instanceof Error ? e.message : e) }, 502);
    }

    // Build claims to persist: start with `extra` (untrusted, may include
    // userinfo fields), then let the verified ID Token claims override.
    // This prevents IdP-side userinfo from overwriting signed assertions.
    const oidcClaims: OidcClaims = {
      ...(claims.extra ?? {}),
      sub: claims.sub,
      username: claims.username,
      email: claims.email,
      name: claims.name,
      nickname: claims.nickname,
      picture: claims.picture,
      employee_id: (claims.extra?.employee_id as string | undefined) ?? undefined,
      tenant_alias: (claims.extra?.tenant_alias as string | undefined) ?? undefined,
      operator_type: (claims.extra?.operator_type as string | undefined) ?? undefined,
    };

    const user = upsertUser(oidcClaims, { adminEmails: opts.adminEmails });
    if (!user.isActive) return c.json({ error: "user account disabled" }, 403);

    const settings = getSettings();
    const session = createSession(
      user.username,
      settings.sessionTtl,
      c.req.header("User-Agent") ?? undefined,
      c.req.header("X-Forwarded-For") ?? undefined,
    );

    log.info(
      `SSO login success [${safeLogValue(providerId, 40)}]: ${safeLogValue(user.username, 40)}`,
    );

    c.header(
      "Set-Cookie",
      buildCookie(
        { name: settings.cookieName, secure: settings.cookieSecure },
        session.id,
        settings.sessionTtl,
      ),
    );
    return c.redirect(saved.next || "/");
  });

  // ── Logout ────────────────────────────────────────────────────
  app.post("/api/auth/sso/logout", (c) => {
    const settings = getSettings();
    const id = readCookie(c, settings.cookieName);
    if (id) {
      deleteSession(id);
      log.info(`SSO logout: ${id.slice(0, 8)}...`);
    }
    c.header("Set-Cookie", clearCookie({ name: settings.cookieName, secure: settings.cookieSecure }));
    return c.json({ ok: true });
  });

  // ── /me ───────────────────────────────────────────────────────
  app.get("/api/auth/me", (c) => {
    const ssoConfigured =
      listProviders({ enabledOnly: true }).length > 0;
    if (!ssoConfigured) return c.json({ user: null, ssoConfigured: false });

    const settings = getSettings();
    const id = readCookie(c, settings.cookieName);
    if (!id) return c.json({ user: null, ssoConfigured: true }, 401);

    const session = getSession(id);
    if (!session) return c.json({ user: null, ssoConfigured: true }, 401);

    const user = getUserByUsername(session.username);
    if (!user || !user.isActive) return c.json({ user: null, ssoConfigured: true }, 401);

    return c.json({
      user: {
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        name: user.name,
        picture: user.picture,
        tenantAlias: user.tenantAlias,
        role: user.role,
      },
      ssoConfigured: true,
    });
  });

  // ── /api/auth/check — nginx auth_request target ───────────────
  // Returns:
  //   200 → user has access (X-User header set for downstream logging)
  //   401 → no session (nginx will redirect to /login)
  //   403 → authed but lacks required role
  app.get("/api/auth/check", (c) => {
    const required = (c.req.query("role") ?? "member") as UserRole;
    const originalUri = c.req.header("X-Original-URI") ?? c.req.path;
    const method = c.req.header("X-Original-Method") ?? "GET";
    const ip = c.req.header("X-Real-IP") ?? c.req.header("X-Forwarded-For") ?? null;
    const ua = c.req.header("User-Agent") ?? null;

    const settings = getSettings();
    const sid = readCookie(c, settings.cookieName);

    const recordAndReturn = (
      status: 200 | 401 | 403,
      username: string | null,
    ) => {
      try {
        appendAccessLog({
          username,
          method,
          path: originalUri,
          status,
          ip,
          userAgent: ua,
        });
      } catch (e) {
        log.warn("access_log append failed", e);
      }
      if (status === 200 && username) {
        c.header("X-User", username);
      }
      return c.body(null, status);
    };

    if (!sid) return recordAndReturn(401, null);

    const session = getSession(sid);
    if (!session) return recordAndReturn(401, null);

    const user = getUserByUsername(session.username);
    if (!user || !user.isActive) return recordAndReturn(401, null);

    // Check role
    const allowed = checkRole(user.role, required);
    if (!allowed) return recordAndReturn(403, user.username);

    return recordAndReturn(200, user.username);
  });

  // ── Host info (admin helper for SSO whitelist) ────────────────
  app.get("/api/v1/system/host-info", (c) => {
    const ifaces = networkInterfaces();
    const ips: Array<{ interface: string; address: string; family: string }> = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs ?? []) {
        if (addr.internal) continue;
        if (addr.family !== "IPv4" && addr.family !== "IPv6") continue;
        ips.push({ interface: name, address: addr.address, family: addr.family });
      }
    }

    const baseUrl = resolveBaseUrl(c);
    const detectedHostname = hostname();

    return c.json({
      hostname: detectedHostname,
      ips,
      currentBaseUrl: baseUrl,
      recommendedCallbacks: [
        `${baseUrl}/api/auth/sso/<providerId>/callback`,
      ],
    });
  });
}
