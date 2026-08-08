// Local login flows: the email verification-code store and its send/verify pair, the Google
// fallback, the auth cookie, and the response shape every successful login returns.
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { createHmac } from "node:crypto";
import { MultiremiStore } from "@multiremi/store/store.js";

export const LOCAL_AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export const localAuthCodes = new Map<string, { code: string; expiresAt: number }>();

// Email verification-code + Google fallback logins let anyone in with just an
// email; production keeps only Feishu SSO. Off unless explicitly enabled (FR9).
export function isEmailCodeLoginEnabled(): boolean {
  const value = (process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function sendLocalAuthCode(
  store: MultiremiStore,
  body: { email?: string; name?: string },
): { ok: true; sent: true; email: string; code: string; expires_at: string } | { error: string; status: 400 } {
  const email = normalizeAuthEmail(body.email);
  if (typeof email !== "string") return email;
  const code = createLocalAuthCode(email);
  const expiresAt = Date.now() + LOCAL_AUTH_CODE_TTL_MS;
  localAuthCodes.set(email, { code, expiresAt });
  if (body.name || email !== store.getCurrentUser().email) {
    store.updateCurrentUser({
      name: String(body.name ?? store.getCurrentUser().name).trim() || "Local User",
      email,
    });
  }
  return {
    ok: true,
    sent: true,
    email,
    code,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export async function verifyLocalAuthCode(
  store: MultiremiStore,
  body: { email?: string; code?: string; name?: string },
): Promise<Awaited<ReturnType<typeof localAuthResponse>> | { error: string; status: 400 | 401 }> {
  const email = normalizeAuthEmail(body.email);
  if (typeof email !== "string") return email;
  const code = String(body.code ?? "").trim();
  if (!code) return { error: "code is required", status: 400 };
  const expected = localAuthCodes.get(email);
  if (!expected || expected.expiresAt < Date.now() || expected.code !== code) {
    return { error: "invalid code", status: 401 };
  }
  localAuthCodes.delete(email);
  return localAuthResponse(store, { email, name: body.name });
}

export async function localGoogleAuthFallback(
  store: MultiremiStore,
  body: { email?: string; name?: string; credential?: string; token?: string },
): Promise<Awaited<ReturnType<typeof localAuthResponse>> | { error: string; status: 400 }> {
  const email = normalizeAuthEmail(body.email ?? store.getCurrentUser().email);
  if (typeof email !== "string") return email;
  return localAuthResponse(store, { email, name: body.name });
}

// HttpOnly login cookie (same name as the Go server's) so native browser
// loads — <img> tags, downloads — carry a credential; the auth middleware
// accepts it for GET/HEAD only. Not marked Secure: the deployment fronts
// plain HTTP, and browsers drop Secure cookies set over http.
export const AUTH_COOKIE_NAME = "multimira_auth";

export const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // matches the 30-day login PAT

export function setAuthCookie(c: Context, token: string): void {
  setCookie(c, AUTH_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function localAuthResponse(
  store: MultiremiStore,
  identity: { externalId?: string | null; email: string; name?: string | null },
): Promise<{
  ok: true;
  token: string;
  access_token: string;
  token_type: "bearer";
  user: ReturnType<MultiremiStore["getCurrentUser"]>;
}> {
  // Provision/resolve the distinct user for this identity, then sign a token that
  // carries that user's real id — never the "local" catch-all. Multiple people
  // logging in each get their own record and their own token.
  const user = store.getOrCreateUser({
    externalId: identity.externalId ?? null,
    email: identity.email,
    name: identity.name ?? null,
  });
  const token = await store.createAccessToken({
    workspaceId: "local",
    userId: user.id,
    name: `Login for ${user.email}`,
    type: "pat",
    expiresInDays: 30,
  });
  return {
    ok: true,
    token: token.token,
    access_token: token.token,
    token_type: "bearer",
    user,
  };
}

export function normalizeAuthEmail(value: unknown): string | { error: string; status: 400 } {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return { error: "email is required", status: 400 };
  if (email.length > 254) return { error: "email is too long", status: 400 };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email is invalid", status: 400 };
  return email;
}

export function createLocalAuthCode(email: string): string {
  if (process.env.MULTIREMI_LOCAL_AUTH_CODE) return process.env.MULTIREMI_LOCAL_AUTH_CODE.trim();
  const digest = createHmac("sha256", process.env.MULTIREMI_TOKEN || "local-bun-multiremi")
    .update(email)
    .update(String(Math.floor(Date.now() / LOCAL_AUTH_CODE_TTL_MS)))
    .digest("hex");
  return String(parseInt(digest.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}
