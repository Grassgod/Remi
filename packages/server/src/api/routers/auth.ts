import type { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  AUTH_COOKIE_NAME,
  buildLarkAuthorizeUrl,
  isEmailCodeLoginEnabled,
  larkExchangeCode,
  larkFetchUserInfo,
  loadLarkSsoConfig,
  localAuthResponse,
  localGoogleAuthFallback,
  readJson,
  sendLocalAuthCode,
  setAuthCookie,
  verifyLocalAuthCode,
} from "../helpers.js";
import type { RouterDeps } from "./deps.js";

export function registerAuthRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.post("/api/cli-token", async (c) => {
    const token = await store.createAccessToken({
      workspaceId: "local",
      name: "CLI token",
      type: "pat",
      purpose: "cli",
    });
    return c.json({ token: token.token });
  });
  app.post("/auth/logout", async (c) => {
    const rawToken = getCookie(c, AUTH_COOKIE_NAME);
    if (rawToken) {
      const token = await store.verifyAccessToken(rawToken, ["pat"]);
      if (token?.purpose === "session") store.revokeAccessToken(token.id);
    }
    deleteCookie(c, AUTH_COOKIE_NAME, { path: "/" });
    return c.json({ message: "logged out" });
  });
  app.post("/auth/send-code", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email code login is disabled" }, 403);
    const result = sendLocalAuthCode(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/auth/verify-code", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email code login is disabled" }, 403);
    const result = await verifyLocalAuthCode(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    setAuthCookie(c, result.token);
    return c.json(result);
  });
  app.post("/auth/google", async (c) => {
    if (!isEmailCodeLoginEnabled()) return c.json({ error: "email login is disabled" }, 403);
    const result = await localGoogleAuthFallback(store, await readJson(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    setAuthCookie(c, result.token);
    return c.json(result);
  });
  app.get("/auth/lark/url", (c) => {
    const cfg = loadLarkSsoConfig();
    if (!cfg) return c.json({ error: "Feishu SSO is not configured" }, 503);
    const redirectUri = c.req.query("redirect_uri");
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    const state = c.req.query("state") ?? "login";
    return c.json({ url: buildLarkAuthorizeUrl(cfg, redirectUri, state) });
  });
  app.post("/auth/lark/callback", async (c) => {
    const cfg = loadLarkSsoConfig();
    if (!cfg) return c.json({ error: "Feishu SSO is not configured" }, 503);
    const body = await readJson<{ code?: string; redirect_uri?: string }>(c);
    const code = String(body.code ?? "").trim();
    const redirectUri = String(body.redirect_uri ?? "").trim();
    if (!code) return c.json({ error: "code is required" }, 400);
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    try {
      const userAccessToken = await larkExchangeCode(cfg, code, redirectUri);
      const profile = await larkFetchUserInfo(cfg, userAccessToken);
      // open_id is the stable per-user identity; Feishu often returns no email,
      // so synthesize one from open_id purely for display/uniqueness.
      const email = profile.email ?? `${profile.openId ?? "feishu-user"}@feishu.local`;
      const payload = await localAuthResponse(store, { externalId: profile.openId, email, name: profile.name });
      setAuthCookie(c, payload.token);
      return c.json(payload);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Feishu login failed" }, 401);
    }
  });
}
