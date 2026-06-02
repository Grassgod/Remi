/**
 * SSO auth middleware — exported for the host app to compose.
 *
 * Behavior:
 *   - If no providers enabled in DB → pass-through (SSO not active)
 *   - SSO endpoints (/api/auth/sso/*, /api/auth/me, host-info) → public
 *   - Other paths → require valid session cookie (else 401)
 *   - Attaches resolved User onto `c.var.user` (typed via SsoVariables below)
 */

import type { MiddlewareHandler } from "hono";
import { listProviders } from "../db/providers.js";
import { getSettings } from "../db/settings.js";
import { getSession, getUserByUsername, type User } from "../db/users.js";
import { readCookie } from "./cookies.js";

/**
 * Hono Variables this middleware writes — host can extend its own
 * `Hono<{ Variables: SsoVariables }>` to get typed `c.var.user`.
 */
export interface SsoVariables {
  user: User;
}

const PUBLIC_PREFIXES = [
  "/api/auth/sso/",       // login/callback/logout/providers
  "/api/auth/me",         // user resolution endpoint itself
  "/api/v1/system/host-info",
];

// Read-only endpoints the public landing (Board "/") needs. Exact-path +
// GET-only so we don't expose the POST/PUT/DELETE siblings (e.g. project
// create lives at POST /api/v1/projects).
const PUBLIC_GET_PATHS = new Set([
  "/api/v1/projects",
  "/api/v1/missions/stats",
  "/api/v1/pages",
]);

function isPublicPath(path: string, method: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p))) return true;
  return method === "GET" && PUBLIC_GET_PATHS.has(path);
}

let _hasProvidersCache: { value: boolean; ts: number } | null = null;
const CACHE_TTL_MS = 5_000;

function ssoActive(): boolean {
  const now = Date.now();
  if (_hasProvidersCache && now - _hasProvidersCache.ts < CACHE_TTL_MS) {
    return _hasProvidersCache.value;
  }
  try {
    const v = listProviders({ enabledOnly: true }).length > 0;
    _hasProvidersCache = { value: v, ts: now };
    return v;
  } catch {
    return false;
  }
}

export function ssoMiddleware(): MiddlewareHandler<{ Variables: SsoVariables }> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (isPublicPath(path, c.req.method)) return next();
    if (!ssoActive()) return next();

    const settings = getSettings();
    const sid = readCookie(c, settings.cookieName);
    if (sid) {
      const session = getSession(sid);
      if (session) {
        const user = getUserByUsername(session.username);
        if (user?.isActive) {
          c.set("user", user);
          return next();
        }
      }
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}
