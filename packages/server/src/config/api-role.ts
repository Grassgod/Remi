/**
 * MUL-461 — the API process role.
 *
 * The S10 split runs two processes of the same image: a `ui` process for browser
 * traffic and a `runtime` process for daemon traffic (MUL-455 §3.2). Nothing is
 * mounted per role — `createMultiremiApp` registers every route for every role, so
 * the route inventory (`scripts/api-routes.golden.json`) and the backend suite stay
 * role-independent — and one guard answers 421 for traffic that belongs to the
 * other process.
 *
 * `all` is the default and means "behave like main": no guard, no response body
 * changes, no extra header. Nothing flips in production until an operator sets the
 * env var.
 */

export type ApiRole = "all" | "ui" | "runtime";

export interface ApiRoleConfiguration {
  role: ApiRole;
  configured: boolean;
}

const API_ROLES = ["all", "ui", "runtime"] as const;

/** Response header naming the role that refused the request. */
export const API_ROLE_HEADER = "X-Remi-Api-Role";

/**
 * Is this a daemon-protocol path?
 *
 * The trailing slash is the whole point: `/api/daemons/:id` (plural) is a browser
 * route registered in the same app, so matching the bare `/api/daemon` prefix
 * would hand a page request to the runtime process.
 */
export function isDaemonPath(pathname: string): boolean {
  return pathname.startsWith("/api/daemon/");
}

/**
 * Resolve the role. Unset, empty and unrecognized values all mean `all`, which is
 * the only value allowed to be a default here: a typo must degrade to main's
 * behavior rather than silently split a single process. `[effective-config]` logs
 * the resolved value at startup, so a typo is visible next to the setting.
 */
export function resolveApiRole(env: Record<string, string | undefined> = process.env): ApiRole {
  const raw = env.MULTIREMI_API_ROLE?.trim().toLowerCase() ?? "";
  return (API_ROLES as readonly string[]).includes(raw) ? raw as ApiRole : "all";
}

/**
 * Was the role configured explicitly (env var present and non-empty)?
 *
 * Health payloads only grow a `role` field when this is true. With the knob unset
 * the bodies stay byte-identical to main — which is what `snapshot-api-routes.ts
 * --check` and acceptance ① of the Issue check — while a container that sets the
 * env var still answers `curl /readyz` with `role:"runtime"` (runbook §6.2 step 3).
 */
export function isApiRoleConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MULTIREMI_API_ROLE?.trim() ?? "") !== "";
}

/**
 * Paths the `runtime` role serves: the daemon protocol, the health trio every
 * container probe uses, and the peer channel (`/internal/*`, MUL-462).
 *
 * An allowlist of exact paths and prefixes rather than a prefix sweep, so
 * `/api/cloud-runtime/healthz` (a browser route) is not mistaken for `/healthz`.
 */
export function isRuntimeAllowedPath(pathname: string): boolean {
  if (isDaemonPath(pathname)) return true;
  if (pathname === "/health" || pathname.startsWith("/health/")) return true;
  if (pathname === "/healthz" || pathname === "/readyz") return true;
  // `/api/multiremi/health` sits in the "mounted for every role" row of §3.2 and
  // backs `remi platform health`.
  if (pathname === "/api/multiremi/health") return true;
  if (pathname === "/internal" || pathname.startsWith("/internal/")) return true;
  return false;
}

/**
 * Would this role refuse this path? Always `false` for `all`, so a caller can skip
 * registering the guard middleware entirely and keep main's middleware chain.
 */
export function isMisdirectedPath(role: ApiRole, pathname: string): boolean {
  if (role === "all") return false;
  if (role === "ui") return isDaemonPath(pathname);
  return !isRuntimeAllowedPath(pathname);
}

/**
 * The 421 answer, shared by the guard middleware and the WebSocket branch of
 * `startMultiremiServer.fetch` (an upgrade short-circuits before Hono). 421 rather
 * than 426 is the point: "this process is the wrong one", not "you forgot to
 * upgrade".
 */
export function misdirectedResponse(role: Exclude<ApiRole, "all">): Response {
  return Response.json(
    { error: "misdirected", role },
    { status: 421, headers: { [API_ROLE_HEADER]: role } },
  );
}
