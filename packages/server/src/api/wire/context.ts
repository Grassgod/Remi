// Request-scoped primitives the wire layer reads.
// Auth identity accessors + tiny pure helpers shared by the serializers below and
// by api.ts itself. Kept in the wire tree (not api.ts) so the serializers can
// depend on them without importing api.ts back — that would be a cycle.
import type { MultiremiAccessToken, MultiremiWorkspaceMember } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { Context } from "hono";

// Request-scoped authentication identity, resolved ONCE by the auth middleware
// (see createMultiremiApp) and read by every gating helper via currentAuth(c).
// Workspace + role are intentionally NOT part of this object: each route addresses
// its own workspace (header/query/body/param/resource), so they remain per-resource
// helpers (currentWorkspaceRole(c, store, workspaceId)) that read this identity.
export interface MultiremiRequestAuth {
  /** Verified access token (pat/task/daemon); null for JWT, master-token, or open mode. */
  readonly accessToken: MultiremiAccessToken | null;
  /** Verified JWT subject; null otherwise. */
  readonly jwtUserId: string | null;
  /** Authenticated identity (access-token user or JWT user); null in master-token / open mode. */
  readonly userId: string | null;
  /** Authenticated identity with the synthetic "local" admin fallback. */
  readonly requestUserId: string;
}

// Declare the request-scoped context variables set via c.set()/read via c.get()
// so Hono's typed context accepts these keys.
declare module "hono" {
  interface ContextVariableMap {
    multiremiAuth: MultiremiRequestAuth;
  }
}

// Anonymous identity: no verified token and no JWT. Used for the master token and
// open (auth-disabled) mode, both of which act as the synthetic "local" admin.
const ANON_REQUEST_AUTH: MultiremiRequestAuth = { accessToken: null, jwtUserId: null, userId: null, requestUserId: "local" };

export function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// The request identity resolved once by the auth middleware. Falls back to the
// anonymous "local" admin when unset (open mode, or routes registered before the
// auth middleware) — identical to the historical "no context key set" behaviour.
export function currentAuth(c: Context): MultiremiRequestAuth {
  return c.get("multiremiAuth") ?? ANON_REQUEST_AUTH;
}

export function currentAccessToken(c: Context): MultiremiAccessToken | null {
  return currentAuth(c).accessToken;
}

export function currentTaskAccessToken(c: Context): MultiremiAccessToken | null {
  const token = currentAccessToken(c);
  return token?.type === "task" ? token : null;
}

export function currentRequestUserId(c: Context): string {
  return currentAuth(c).requestUserId;
}

export function authenticatedRequestUserId(c: Context): string | null {
  return currentAuth(c).userId;
}

export function workspaceAlwaysRedactSecrets(settings: Record<string, unknown> | null | undefined): boolean {
  const value = settings?.always_redact_env;
  return value === true || value === 1 || value === "1" || value === "true";
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasRequestField(input: object, ...fields: string[]): boolean {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

export function currentWorkspaceRoleStrict(c: Context, store: MultiremiStore, workspaceId: string): string | null {
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (member) return member.role;
  if (workspaceId === "local" && authenticatedRequestUserId(c) === null) return "owner";
  return null;
}

export function currentWorkspaceMember(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
): MultiremiWorkspaceMember | null {
  const userId = currentRequestUserId(c);
  return store.listWorkspaceMembers(workspaceId).find((item) =>
    item.userId === userId || item.id === userId || item.id === `mem_${workspaceId}_${userId}`
  ) ?? null;
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
