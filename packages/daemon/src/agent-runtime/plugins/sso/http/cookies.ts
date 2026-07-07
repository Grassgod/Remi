/**
 * Cookie helpers — keep cookie format consistent across handlers + middleware.
 */

import type { Context } from "hono";

export interface CookieOpts {
  name: string;
  secure: boolean;
}

export function buildCookie(opts: CookieOpts, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${opts.name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(opts: CookieOpts): string {
  const parts = [
    `${opts.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(c: Context, name: string): string | null {
  const cookie = c.req.header("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}
