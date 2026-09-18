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
import { PasswordLoginLimiter } from "../helpers/password-login.js";
import { readRequestBodyLimited } from "../helpers/webhooks.js";
import { authenticatedRequestUserId, currentAccessToken, currentRequestUserId, isObjectRecord } from "../wire/context.js";
import { PasswordAccountError, normalizePasswordLoginEmail } from "@multiremi/store/repos/password-accounts-repo.js";

export function registerAuthRoutes(app: Hono, deps: RouterDeps): void {
  const { store, authToken } = deps;
  const passwordLimiter = new PasswordLoginLimiter();

  app.post("/api/auth/password-accounts", async (c) => {
    const header = c.req.header("Authorization") ?? "";
    const explicitOpenLocal = !authToken && !header
      && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
    if (!(authToken && header === `Bearer ${authToken}`) && !explicitOpenLocal) {
      return c.json({ error: "deployment master authentication required" }, 403);
    }
    const input = await readPasswordBody(c.req.raw);
    if (!input) return c.json({ error: "invalid account configuration" }, 400);
    try {
      if (typeof input.email !== "string" || typeof input.password !== "string"
        || (input.name !== undefined && typeof input.name !== "string")
        || (input.workspaceId !== undefined && typeof input.workspaceId !== "string")) {
        return c.json({ error: "invalid account configuration" }, 400);
      }
      const account = await store.configurePasswordAccount({
        email: input.email, password: input.password,
        name: input.name, workspaceId: input.workspaceId,
      });
      return c.json(account, 201);
    } catch (error) {
      if (error instanceof PasswordAccountError) return c.json({ error: error.message }, error.status);
      return c.json({ error: "could not configure password account" }, 500);
    }
  });

  app.post("/auth/password", async (c) => {
    if (process.env.MULTIREMI_ALLOW_PASSWORD_LOGIN !== "1") return c.json({ error: "password login is disabled" }, 403);
    const limited = () => { c.header("Retry-After", "60"); return c.json({ error: "too many login attempts" }, 429); };
    if (!passwordLimiter.enter()) return limited();
    try {
      const input = await readPasswordBody(c.req.raw);
      const email = normalizePasswordLoginEmail(input?.email);
      const password = input?.password;
      if (!email || typeof password !== "string" || password.length < 6 || password.length > 1024) {
        return c.json({ error: "invalid email or password" }, 401);
      }
      if (!passwordLimiter.allowAccount(email)) return limited();
      const session = await store.loginWithPassword(email, password);
      if (!session) return c.json({ error: "invalid email or password" }, 401);
      setAuthCookie(c, session.token);
      return c.json(session);
    } catch {
      return c.json({ error: "invalid email or password" }, 401);
    } finally {
      passwordLimiter.leave();
    }
  });

  app.post("/api/cli-token", async (c) => {
    const userId = currentRequestUserId(c);
    if (userId !== "local" && !store.getUser(userId)) return c.json({ error: "unauthorized" }, 401);
    const source = currentAccessToken(c);
    // Keep the migrated owner a verified human without promoting legacy machine
    // credentials to a human session or a different workspace.
    const localSession = userId === "local" && (
      source?.purpose === "session" || (!source && authenticatedRequestUserId(c) === "local")
    );
    const token = await store.createAccessToken({
      workspaceId: source?.workspaceId ?? "local",
      name: "CLI token",
      userId,
      type: "pat",
      purpose: localSession ? "session" : "cli",
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
      // union_id links this login to events from other apps owned by the same
      // service provider. Keep open_id for compatibility with existing users;
      // Feishu often returns no email, so synthesize one only as a fallback.
      const email = profile.email ?? `${profile.openId ?? "feishu-user"}@feishu.local`;
      const payload = await localAuthResponse(store, {
        externalId: profile.openId,
        feishuUnionId: profile.unionId,
        email,
        name: profile.name,
      });
      setAuthCookie(c, payload.token);
      return c.json(payload);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Feishu login failed" }, 401);
    }
  });
}

async function readPasswordBody(request: Request): Promise<Record<string, unknown> | null> {
  const result = await readRequestBodyLimited(request, 8 * 1024);
  if ("apiError" in result) return null;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(result.bytes));
    return isObjectRecord(body) ? body : null;
  } catch {
    return null;
  }
}
