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

/**
 * MUL-456 fix round 1: does this request carry a *verified* credential?
 *
 * The anonymous compatibility modes — auth disabled, or the deployment master
 * token — deliberately keep the historical trust-the-body behaviour, and those
 * are exactly the requests with no verified identity: `currentAuth` falls back
 * to {@link ANON_REQUEST_AUTH} and the middleware leaves the context unset.
 * Every real credential (member PAT, login JWT, task token, daemon token)
 * yields a non-null `accessToken` or `jwtUserId`, so this reads the existing
 * authentication state rather than inventing a new switch.
 */
export function hasVerifiedRequestIdentity(c: Context): boolean {
  const auth = currentAuth(c);
  return auth.accessToken !== null || auth.jwtUserId !== null;
}

/**
 * MUL-456 fix round 1: request body fields a verified credential owns on every
 * task-creation surface.
 *
 * `parent_task_id` is lineage the server derives from the caller's task
 * credential — the caller's own task id for a task token, `null` for a member
 * PAT, a login session or any other credential. The store reads
 * `parentTaskId ?? parent_task_id`, so leaving the snake_case alias in a
 * verified body would win exactly when the credential carries no lineage: the
 * manual wake-up a member can plant would then pass the D4 `wake_source IS NULL`
 * check and swallow the real return. Anonymous compatibility (auth disabled /
 * master token) keeps its historical pass-through and is deliberately not
 * stripped here.
 */
export function stripParentTaskLineage<T extends object>(input: T): T {
  const out = { ...(input as Record<string, unknown>) };
  delete out.parentTaskId;
  delete out.parent_task_id;
  return out as T;
}

/**
 * The body a task-creation route hands to the store.
 *
 * A verified credential's request cannot name its own lineage, so both
 * spellings are dropped. Anonymous compatibility keeps the old behaviour: the
 * route's camelCase stamp used to override a camelCase body value while the
 * snake_case alias survived the store's `??`, so only the camelCase key is
 * dropped here and the alias stays available to the helper below.
 */
export function requestTaskLineageBody<T extends object>(c: Context, body: T): T {
  if (hasVerifiedRequestIdentity(c)) return stripParentTaskLineage(body);
  const out = { ...(body as Record<string, unknown>) };
  delete out.parentTaskId;
  return out as T;
}

/**
 * The lineage override a task-creation route stamps over the body.
 *
 * A verified credential always stamps the key: its own task id for a task
 * token, and an explicit `null` for a member PAT, login JWT or daemon. The
 * explicit key is what stops the store's historical fallbacks (the snake_case
 * alias and a trigger comment's run id) from being steered by a request body.
 *
 * Anonymous compatibility reproduces the old `null ?? body.parent_task_id`
 * read exactly: the alias is stamped when the body carries it, and otherwise no
 * key is stamped at all, leaving the store's other fallbacks in charge as
 * before.
 */
export function requestParentTaskLineage(
  c: Context,
  body: object,
): { parentTaskId?: string | null } {
  if (hasVerifiedRequestIdentity(c)) {
    return { parentTaskId: currentTaskAccessToken(c)?.taskId ?? null };
  }
  if (!Object.hasOwn(body, "parent_task_id")) return {};
  const lineage = (body as { parent_task_id?: unknown }).parent_task_id;
  return { parentTaskId: cleanString(typeof lineage === "string" ? lineage : null) ?? null };
}

/**
 * The `/api/multiremi/tasks` variant.
 *
 * That route has always destructured both spellings out of the body before it
 * stamped anything, so a body could never supply the value. A verified
 * credential still stamps its own (an explicit `null` for a member PAT, which
 * also forbids the store's trigger-comment fallback from being steered), while
 * anonymous compatibility stamps nothing and leaves the store's historical
 * fallbacks in charge.
 */
export function requestStrippedParentTaskLineage(c: Context): { parentTaskId?: string | null } {
  if (!hasVerifiedRequestIdentity(c)) return {};
  return { parentTaskId: currentTaskAccessToken(c)?.taskId ?? null };
}

export function currentRequestUserId(c: Context): string {
  return currentAuth(c).requestUserId;
}

/**
 * MUL-448: the anonymous compatibility mode, told apart from a credentialed
 * request by the verification result the auth middleware already produced.
 *
 * `currentAuth` carries no access token and no verified user for the master
 * token and for auth-disabled deployments - the two deployments that
 * historically let a request name its own identity through the body or the
 * `X-Agent-ID`/`X-Task-ID` headers. Every other request (member PAT, login JWT,
 * task token, daemon token) is credentialed and must derive identity from it.
 */
export function isAnonymousCompatibilityRequest(c: Context): boolean {
  const auth = currentAuth(c);
  return !auth.accessToken && !auth.jwtUserId;
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
  return store.findWorkspaceMemberForUser(currentRequestUserId(c), workspaceId);
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
