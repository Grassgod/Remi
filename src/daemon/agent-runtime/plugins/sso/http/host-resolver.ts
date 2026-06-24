/**
 * Derive the public base URL of the running server from the incoming request.
 * This is what makes the plugin "portable" — no base_url config needed.
 *
 * Order of resolution:
 *   1. X-Forwarded-Proto + X-Forwarded-Host (when behind a reverse proxy)
 *   2. Host header + URL-derived protocol
 */

import type { Context } from "hono";

export function resolveBaseUrl(c: Context): string {
  const xfProto = c.req.header("X-Forwarded-Proto");
  const xfHost = c.req.header("X-Forwarded-Host");
  if (xfProto && xfHost) {
    return `${xfProto}://${xfHost}`;
  }

  const host = c.req.header("Host");
  // Hono's c.req.url has the full URL; use it to get the protocol
  const proto = new URL(c.req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function resolveCallbackUrl(c: Context, providerId: string): string {
  return `${resolveBaseUrl(c)}/api/auth/sso/${encodeURIComponent(providerId)}/callback`;
}

export function resolveHomeUrl(c: Context): string {
  return `${resolveBaseUrl(c)}/`;
}
