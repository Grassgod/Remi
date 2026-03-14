/**
 * Bearer token authentication middleware for Hono
 */

import type { MiddlewareHandler } from "hono";

export function authMiddleware(authToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (!authToken) return next();

    const header = c.req.header("Authorization");
    if (header === `Bearer ${authToken}`) return next();

    const queryToken = c.req.query("token");
    if (queryToken === authToken) return next();

    return c.json({ error: "Unauthorized" }, 401);
  };
}
