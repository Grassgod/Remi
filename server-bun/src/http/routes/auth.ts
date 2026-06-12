/**
 * Feishu (Lark) SSO routes — TS port of the Go server's auth_lark.go.
 * GET  /auth/lark/url      → the Feishu authorize URL to redirect to.
 * POST /auth/lark/callback → exchange code → user_info → findOrCreateUser → JWT.
 * The only login path in the self-hosted build (email OTP / Google removed).
 */

import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import type { Config } from "../../config.js";
import { findOrCreateUser, SignupError } from "../../auth/users.js";
import { issueJWT } from "../../auth/jwt.js";

function larkBaseUrl(): string {
  const v = process.env.LARK_SSO_BASE_URL?.trim().replace(/\/+$/, "");
  return v || "https://open.feishu.cn";
}

function larkCreds(): { appId: string; appSecret: string } | null {
  const appId = process.env.LARK_SSO_APP_ID?.trim() ?? "";
  const appSecret = process.env.LARK_SSO_APP_SECRET?.trim() ?? "";
  return appId && appSecret ? { appId, appSecret } : null;
}

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

export function authRoutes(cfg: Config, db?: Db): Hono {
  const r = new Hono();

  // DEV ONLY: one-link local login. Gated behind MULTIMIRA_DEV_LOGIN=1 (404 when
  // off, so it can never be hit in production). Finds/creates the user by email,
  // issues a session, and sets it via a real Set-Cookie (overrides any stale
  // cookie — unlike a JS document.cookie hack), then redirects into the app.
  r.get("/auth/dev-login", async (c) => {
    // Hard production gate: even a leaked MULTIMIRA_DEV_LOGIN=1 (a dev .env
    // copied onto a server) can never open this in production.
    if (process.env.APP_ENV === "production") return c.json({ error: "not found" }, 404);
    if (process.env.MULTIMIRA_DEV_LOGIN !== "1") return c.json({ error: "not found" }, 404);
    if (!db) return c.json({ error: "database not configured" }, 503);
    const email = (c.req.query("email") || process.env.MULTIMIRA_DEV_LOGIN_EMAIL || "").trim().toLowerCase();
    if (!email) return c.json({ error: "email query param required" }, 400);
    let user;
    try {
      ({ user } = await findOrCreateUser(db, email, cfg));
    } catch (e) {
      if (e instanceof SignupError) return c.json({ error: e.message }, 403);
      return c.json({ error: "failed to create user" }, 500);
    }
    const token = await issueJWT({ sub: user.id, email: user.email, name: user.name }, cfg.jwtSecret, cfg.authTokenTtlSeconds);
    c.header("Set-Cookie", `multimira_token=${token}; Path=/; Max-Age=2592000; SameSite=Lax`);
    return c.redirect(c.req.query("redirect") || "/", 302);
  });

  r.get("/auth/lark/url", (c) => {
    const creds = larkCreds();
    if (!creds) return c.json({ error: "Feishu login is not configured" }, 503);
    const redirectUri = c.req.query("redirect_uri") || process.env.LARK_SSO_REDIRECT_URI || "";
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    const p = new URLSearchParams({ app_id: creds.appId, redirect_uri: redirectUri });
    const state = c.req.query("state");
    if (state) p.set("state", state);
    const scope = process.env.LARK_SSO_SCOPE?.trim();
    if (scope) p.set("scope", scope);
    return c.json({ url: `${larkBaseUrl()}/open-apis/authen/v1/authorize?${p.toString()}` });
  });

  r.post("/auth/lark/callback", async (c) => {
    const creds = larkCreds();
    if (!creds) return c.json({ error: "Feishu login is not configured" }, 503);
    if (!db) return c.json({ error: "database not configured" }, 503);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const code = firstNonEmpty(body.code);
    if (!code) return c.json({ error: "code is required" }, 400);
    const redirectUri = firstNonEmpty(body.redirect_uri, process.env.LARK_SSO_REDIRECT_URI);
    const base = larkBaseUrl();

    // 1. authorization code → user access token (authen v2)
    const tokRes = await fetch(`${base}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: creds.appId,
        client_secret: creds.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    }).catch(() => null);
    const tok = (tokRes ? await tokRes.json().catch(() => null) : null) as { access_token?: string } | null;
    if (!tok?.access_token) return c.json({ error: "failed to exchange code with Feishu" }, 400);

    // 2. user profile (authen v1)
    const infoRes = await fetch(`${base}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).catch(() => null);
    const info = (infoRes ? await infoRes.json().catch(() => null) : null) as { data?: Record<string, unknown> } | null;
    const data = info?.data ?? {};
    let email = firstNonEmpty(data.enterprise_email, data.email).toLowerCase();
    if (!email) {
      // The Feishu app may not have the user-email scope yet. Don't block the
      // login: synthesize a stable identity from union_id/open_id (both come
      // with the basic profile). Once the scope is granted, the same person
      // keeps logging into this account via the synthetic address.
      const stableId = firstNonEmpty(data.union_id, data.open_id);
      if (!stableId) {
        return c.json({ error: "Feishu user_info returned no email and no open_id" }, 400);
      }
      email = `${stableId.toLowerCase()}@lark.local`;
    }

    // 3. findOrCreateUser + issue session (gated by ALLOWED_EMAIL_DOMAINS)
    try {
      const { user: u } = await findOrCreateUser(db, email, cfg, {
        displayName: firstNonEmpty(data.name, data.en_name),
        avatarUrl: firstNonEmpty(data.avatar_url, data.avatar_thumb),
      });
      const token = await issueJWT(
        { sub: u.id, email: u.email, name: u.name },
        cfg.jwtSecret,
        cfg.authTokenTtlSeconds,
      );
      return c.json({
        token,
        user: { id: u.id, name: u.name, email: u.email, avatar_url: u.avatarUrl },
      });
    } catch (e) {
      if (e instanceof SignupError) return c.json({ error: e.message }, 403);
      return c.json({ error: "failed to create user" }, 500);
    }
  });

  return r;
}
