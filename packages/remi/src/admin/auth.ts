/**
 * Legacy bearer-token middleware for Hono.
 *
 * SSO session cookie auth is provided separately by the SSO plugin
 * (src/daemon/agent-runtime/plugins/sso) and is composed in
 * src/remi/admin/server.ts before this one.
 *
 * This middleware is a no-op unless REMI_WEB_AUTH_TOKEN is set.
 */

import type { MiddlewareHandler } from "hono";

export function authMiddleware(authToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (!authToken) return next();

    // If SSO already attached a user, skip the bearer check
    const user = c.get("user" as never);
    if (user) return next();

    const header = c.req.header("Authorization");
    if (header === `Bearer ${authToken}`) return next();

    const queryToken = c.req.query("token");
    if (queryToken === authToken) return next();

    return c.json({ error: "Unauthorized" }, 401);
  };
}
