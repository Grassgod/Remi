// Request authorization. Resolves the caller identity out of the Hono context, then answers the
// two questions every route asks: may this token reach this surface at all (task/daemon token
// scoping), and may this user reach this workspace/agent/attachment. `deny*` helpers return a
// ready-made Response when access is refused and null when it is allowed.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import { daemonRuntimeId } from "@multiremi/store/helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  currentAccessToken,
  currentAuth,
  currentRequestUserId,
  currentWorkspaceMember,
  currentWorkspaceRoleStrict,
  runtimeWorkspaceId,
} from "../wire/index.js";
import type { MultiremiRequestAuth } from "../wire/index.js";
import type {
  CreateAccessTokenInput,
  MultiremiAccessToken,
  MultiremiAgent,
  MultiremiAttachment,
  MultiremiChatSession,
  MultiremiRuntime,
  MultiremiTask,
  MultiremiWorkspaceMember,
} from "@multiremi/contracts/types.js";

// Resolve the request identity into a single typed object. Mirrors the historical
// currentJwtUserId (cleanString) / currentRequestUserId / authenticatedRequestUserId logic.
export function buildRequestAuth(accessToken: MultiremiAccessToken | null, jwtUserId: string | null): MultiremiRequestAuth {
  const cleanJwt = cleanString(jwtUserId);
  const userId = accessToken?.userId ?? cleanJwt ?? null;
  return { accessToken, jwtUserId: cleanJwt, userId, requestUserId: userId ?? "local" };
}

export function isDaemonTokenAllowedRequest(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === "/health" || path === "/healthz" || path === "/readyz" || path === "/api/multiremi/health") {
    return true;
  }
  if ((path === "/api/cli/context" || path === "/api/cli/capabilities") && method === "GET") return true;
  if (path === "/api/daemon/ws" || path.startsWith("/api/daemon/")) return true;
  if (path === "/api/multiremi/runtimes" && method === "POST") return true;
  if (method === "GET" && (path === "/api/runtimes" || path === "/api/multiremi/runtimes"
    || /^\/api\/(?:multiremi\/)?runtimes\/[^/]+(?:\/.*)?$/.test(path))) return true;
  if (/^\/api\/multiremi\/runtimes\/[^/]+\/heartbeat$/.test(path) && method === "POST") return true;
  return false;
}

export type TaskTokenHardDenyCategory =
  | "access_credentials"
  | "workspace_identity"
  | "workspace_lifecycle"
  | "privilege_configuration"
  | "billing"
  | "platform_maintenance"
  | "daemon_identity";

/**
 * Task credentials inherit their owner's normal authority inside the bound
 * workspace, including access to business configuration such as environment
 * values and SCM settings. Credential-minting/reveal surfaces, identity and
 * workspace lifecycle, billing, and machine identity mutations remain
 * unavailable. Operational agents may inspect platform status and manage the
 * platform operation lifecycle, but cannot change updater settings or call the
 * updater's machine-facing API. This is an intentional usability/security
 * tradeoff: untrusted task input can exercise the owner's workspace and
 * deployment authority, but cannot mint a new access capability or assume a
 * daemon identity.
 */
export function taskTokenHardDenyCategory(request: Request): TaskTokenHardDenyCategory | null {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === "/api/tokens" || path.startsWith("/api/tokens/")
    || path === "/api/multiremi/tokens" || path.startsWith("/api/multiremi/tokens/")
    || path === "/api/cli-token"
    || /^\/api\/issues\/[^/]+\/share(?:\/extend)?$/.test(path)
    || /^\/api\/autopilots\/[^/]+\/triggers\/[^/]+\/(?:rotate-webhook-token|signing-secret)$/.test(path)
    || /^\/api\/workspaces\/[^/]+\/relay-config\/[^/]+\/reveal$/.test(path)) {
    return "access_credentials";
  }
  if (path === "/api/me" || path.startsWith("/api/me/")
    || path === "/api/invitations" || path.startsWith("/api/invitations/")
    || path === "/api/multiremi/members" || path.startsWith("/api/multiremi/members/")
    || /^\/api\/workspaces\/[^/]+\/(?:members|invitations)(?:\/.*)?$/.test(path)
    || (/^\/api\/workspaces\/[^/]+\/lark\/install\/begin$/.test(path) && method === "POST")
    || (/^\/api\/workspaces\/[^/]+\/lark\/installations\/[^/]+$/.test(path) && method === "DELETE")
    || path === "/api/lark/binding/redeem"
    || path === "/auth/logout" || path.startsWith("/auth/google")
    || path.startsWith("/auth/send-code") || path.startsWith("/auth/verify-code")
    || path.startsWith("/auth/lark/")) {
    return "workspace_identity";
  }
  if ((path === "/api/workspaces" && method === "POST")
    || (/^\/api\/workspaces\/[^/]+$/.test(path) && method === "DELETE")
    || (/^\/api\/workspaces\/[^/]+\/leave$/.test(path) && method === "POST")) {
    return "workspace_lifecycle";
  }
  if ((/^\/api\/agents\/[^/]+\/(?:role|supervisor)$/.test(path) && method === "PUT")
    || (/^\/api\/workspaces\/[^/]+\/repository-wikis\/atlas$/.test(path) && method === "POST")
    || (/^\/api\/workspaces\/[^/]+\/organizer$/.test(path) && method === "PUT")) {
    return "privilege_configuration";
  }
  if (path === "/api/cloud-billing" || path.startsWith("/api/cloud-billing/")) return "billing";
  const taskAllowedPlatformRequest = (method === "GET" && path === "/api/multiremi/platform/status")
    || path === "/api/multiremi/platform/operations"
    || path.startsWith("/api/multiremi/platform/operations/");
  if ((!taskAllowedPlatformRequest
      && (path === "/api/multiremi/platform" || path.startsWith("/api/multiremi/platform/")))
    || path === "/api/platform-updater" || path.startsWith("/api/platform-updater/")
    || path === "/api/cloud-runtime" || path.startsWith("/api/cloud-runtime/")
    || path === "/api/multiremi/install/daemon"
    || (/^\/api\/runtimes\/[^/]+$/.test(path) && method === "DELETE")
    || (/^\/api\/runtimes\/[^/]+\/archive-agents-and-delete$/.test(path) && method === "POST")
    || (/^\/api\/(?:multiremi\/)?runtimes\/[^/]+\/update$/.test(path) && method === "POST")
    || /^\/api\/runtimes\/[^/]+\/commands(?:\/[^/]+)?$/.test(path)
    || /^\/api\/workspaces\/[^/]+\/runtime-provisions(?:\/[^/]+(?:\/states)?)?$/.test(path)
    || (/^\/api\/multiremi\/daemons\/[^/]+\/retire$/.test(path) && method === "POST")
    || (/^\/api\/workspaces\/[^/]+\/ssh-mesh$/.test(path) && method === "PUT")
    || (/^\/api\/workspaces\/[^/]+\/ssh-mesh\/rotate$/.test(path) && method === "POST")) {
    return "platform_maintenance";
  }
  const taskGitCredentialRequest = path === "/api/daemon/scm/git-credentials" && method === "POST";
  if ((!taskGitCredentialRequest && (path === "/api/daemon/ws" || path.startsWith("/api/daemon/")))
    || (path === "/api/multiremi/runtimes" && method === "POST")
    || (/^\/api\/multiremi\/runtimes\/[^/]+\/heartbeat$/.test(path) && method === "POST")) {
    return "daemon_identity";
  }
  return null;
}

export function isTaskTokenHardDeniedRequest(request: Request): boolean {
  return taskTokenHardDenyCategory(request) !== null;
}

/**
 * The daemon execution surface is machine-to-server control plane traffic.
 * Human PAT/JWT credentials may bootstrap/register a daemon, but must never
 * claim work or mutate daemon-owned state. The deployment master credential
 * and explicitly open local mode retain their historical compatibility.
 */
export function denyNonDaemonOperationalAccess(
  c: Context,
  authToken: string,
  store: MultiremiStore,
): Response | null {
  if (c.req.path === "/api/daemon/register") return null;
  if (!authToken) return null;
  if (c.req.header("Authorization") === `Bearer ${authToken}`) return null;
  const token = currentAccessToken(c);
  if (
    c.req.path === "/api/daemon/scm/git-credentials"
    && c.req.method === "POST"
    && token?.type === "task"
  ) {
    return null;
  }
  if (
    c.req.path === "/api/daemon/heartbeat" &&
    token?.type === "pat" &&
    token.purpose === "cli"
  ) {
    return null;
  }
  if (token?.type === "daemon" && cleanString(token.daemonId)) {
    return denyDaemonOwnerWorkspaceMembership(c, store);
  }
  return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
}

export function isDaemonOwnerWorkspaceMember(
  store: MultiremiStore,
  token: Pick<MultiremiAccessToken, "type" | "userId" | "workspaceId"> | null,
): boolean {
  if (!token || token.type !== "daemon") return true;
  const ownerUserId = cleanString(token.userId);
  return !ownerUserId
    || ownerUserId === "local"
    || Boolean(store.getUserRoleInWorkspace(ownerUserId, token.workspaceId));
}

export function denyDaemonOwnerWorkspaceMembership(
  c: Context,
  store: MultiremiStore,
): Response | null {
  if (isDaemonOwnerWorkspaceMember(store, currentAccessToken(c))) return null;
  return c.json(
    {
      error: "daemon owner is no longer a workspace member",
      code: "daemon_owner_membership_required",
    },
    403,
  );
}

/**
 * An ownerless daemon found in persistent state is a recovery case, not an
 * invitation for the first workspace member who knows its id to claim it.
 * Managers may recover it; a credential that was already bound to the exact
 * daemon remains usable for rolling upgrades.
 */
export function denyUnprivilegedOwnerlessDaemonClaim(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  daemonId: string | null | undefined,
): Response | null {
  const normalizedDaemonId = cleanString(daemonId);
  if (!normalizedDaemonId) return null;
  const token = currentAccessToken(c);
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  const callerUserId = authenticatedRequestUserId(c);
  const boundDaemonCredential = token?.type === "daemon"
    && cleanString(token.daemonId) === normalizedDaemonId;
  const legacyRuntimeConflict = store.listRuntimes().find((runtime) =>
    (runtime.workspaceId ?? "local") === workspaceId
    && !cleanString(runtime.daemonId)
    && runtime.id === daemonRuntimeId(normalizedDaemonId, runtime.provider)
    && (
      runtime.ownerId
        ? runtime.ownerId !== callerUserId
        : !boundDaemonCredential && role !== "owner" && role !== "admin"
    )
  );
  if (legacyRuntimeConflict) {
    return c.json({
      error: "legacy runtime recovery requires its owner or a workspace administrator",
      code: "legacy_runtime_owner_conflict",
    }, 403);
  }
  const plan = store.getDaemonRetirementPlan(workspaceId, normalizedDaemonId);
  if (!plan.exists || plan.ownerUserId) return null;
  if (boundDaemonCredential) return null;
  if (role === "owner" || role === "admin") return null;
  return c.json({
    error: "ownerless daemon recovery requires a workspace administrator",
    code: "daemon_owner_recovery_required",
  }, 403);
}

/**
 * Upgrade the legacy add-computer CLI PAT in-place during its first daemon
 * registration. The raw token stays unchanged on disk, while its server-side
 * authority becomes a workspace-scoped, daemon-bound machine credential.
 */
export function promoteLegacyCliPatForDaemonRegistration(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  daemonId: string,
): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "pat" || token.purpose !== "cli") return null;
  const normalizedWorkspaceId = cleanString(workspaceId) ?? "local";
  const normalizedDaemonId = cleanString(daemonId);
  if (!normalizedDaemonId) {
    return c.json({ error: "daemon_id is required", code: "daemon_id_required" }, 400);
  }
  if (token.workspaceId !== normalizedWorkspaceId) {
    return c.json({ error: "forbidden for token workspace" }, 403);
  }
  const membershipDenied = denyCurrentUserWorkspaceAccess(c, store, normalizedWorkspaceId);
  if (membershipDenied) return membershipDenied;
  const promoted = store.promoteCliAccessTokenToDaemon(
    token.id,
    normalizedWorkspaceId,
    normalizedDaemonId,
  );
  if (!promoted) {
    return c.json({ error: "daemon credential upgrade failed", code: "daemon_credential_upgrade_failed" }, 403);
  }
  c.set("multiremiAuth", buildRequestAuth(promoted, currentAuth(c).jwtUserId));
  return null;
}

/** Rolling-upgrade companion to registration promotion for already-running daemons. */
export function promoteLegacyCliPatForDaemonHeartbeat(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "pat" || token.purpose !== "cli") return null;
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  const workspaceId = cleanString(runtime.workspaceId) ?? "local";
  const membershipDenied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (membershipDenied) return membershipDenied;
  const promoted = store.promoteCliAccessTokenForRuntime(token.id, runtimeId);
  if (!promoted) {
    return c.json({ error: "daemon credential upgrade failed", code: "daemon_credential_upgrade_failed" }, 403);
  }
  c.set("multiremiAuth", buildRequestAuth(promoted, currentAuth(c).jwtUserId));
  return null;
}

export function isTaskTokenCreateInput(input: Pick<CreateAccessTokenInput, "type">): boolean {
  return String(input.type ?? "pat").trim().toLowerCase() === "task";
}

export function denyCurrentUserCommentAccess(
  c: Context,
  store: MultiremiStore,
  commentId: string,
): Response | null {
  const comment = store.getIssueComment(commentId);
  if (!comment) return null;
  const issue = store.getIssue(comment.issueId);
  return issue ? denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId) : null;
}

export function currentJwtUserId(c: Context): string | null {
  return currentAuth(c).jwtUserId;
}

export function compatibilityWorkspaceId(c: Context): string {
  return cleanString(c.req.header("X-Workspace-ID")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

// The web client tags every request with the slug of the workspace the user is
// viewing (client.ts authHeaders). Null when absent or not a known workspace.
export function workspaceIdFromSlugHeader(c: Context, store: MultiremiStore): string | null {
  const slug = cleanString(c.req.header("X-Workspace-Slug"));
  if (!slug) return null;
  return store.listWorkspaces().find((workspace) => workspace.slug === slug)?.id ?? null;
}

export function compatibilityUserId(c: Context): string {
  return authenticatedRequestUserId(c) ??
    cleanString(c.req.query("user_id")) ??
    "local";
}

export function compatibilityInboxMemberId(c: Context, store: MultiremiStore): string {
  const raw = authenticatedRequestUserId(c) ??
    cleanString(c.req.query("member_id")) ??
    "local";
  // Inbox rows are keyed by member-table ids (mem_<ws>_<user>) — every
  // createInboxItem writer passes a member id — while auth yields the USER id.
  // Querying with the raw user id silently returns an empty inbox (MUL-38: 151
  // unread notifications invisible in the web UI). Accept an exact member id
  // untouched; otherwise resolve the user's membership, scoped to the request's
  // workspace when the slug header names one.
  if (store.getWorkspaceMember(raw)) return raw;
  const workspaceId = workspaceIdFromSlugHeader(c, store);
  const membership = store.listWorkspaceMembers(workspaceId).find((member) => member.userId === raw);
  return membership?.id ?? raw;
}

export function denyCurrentUserRuntimeWorkspaceAccess(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): Response | null {
  const workspaceId = runtimeWorkspaceId(runtime);
  const token = currentAccessToken(c);
  if (token?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const userId = authenticatedRequestUserId(c);
  // Same rule as denyCurrentUserWorkspaceAccess: a human's login PAT is not
  // workspace-scoped — membership decides which runtimes they can see.
  const humanPat = token?.type === "pat" && userId && userId !== "local";
  if (!humanPat && token?.workspaceId && token.workspaceId !== workspaceId) {
    return c.json({ error: "runtime not found" }, 404);
  }
  // A logged-in human who is not a member of the runtime's workspace can't see it.
  if (userId && userId !== "local" && !store.getUserRoleInWorkspace(userId, workspaceId)) {
    return c.json({ error: "runtime not found" }, 404);
  }
  return null;
}

export function canCurrentUserAccessAgent(c: Context, store: MultiremiStore, agent: MultiremiAgent): boolean {
  if (agent.visibility !== "private") return true;
  const userId = currentRequestUserId(c);
  if (agent.ownerId === userId) return true;
  const role = currentWorkspaceRole(c, store, agent.workspaceId);
  return role === "owner" || role === "admin";
}

// Store-only twin of canCurrentUserAccessAgent — no request Context, so it can
// gate WS recipients (client.data.userId) as well as HTTP callers.
export function canUserAccessAgentByUserId(store: MultiremiStore, userId: string | null, agent: MultiremiAgent): boolean {
  if (agent.visibility !== "private") return true;
  if (userId && agent.ownerId === userId) return true;
  // No verified identity (master token / open mode) acts as admin.
  if (userId == null) return true;
  const role = store.getUserRoleInWorkspace(userId, agent.workspaceId);
  return role === "owner" || role === "admin";
}

// Whether a user may read a task's transcript messages. Transcript rows carry
// raw tool input/diffs/output, so they inherit the task's visibility: chat
// tasks are creator-only, and a private agent's task is owner/admin-only.
// Workspace membership itself is enforced by the caller (registry keying /
// route guard). userId null = no-identity admin path.
export function canUserViewTaskMessages(store: MultiremiStore, userId: string | null, task: MultiremiTask): boolean {
  if (task.chatSessionId) {
    const session = store.getChatSession(task.chatSessionId);
    if (!session) return false;
    if (userId == null) return true;
    return session.creatorId === userId;
  }
  const agent = task.agentId ? store.getAgent(task.agentId) : null;
  if (!agent) return true;
  return canUserAccessAgentByUserId(store, userId, agent);
}

export function currentWorkspaceRole(c: Context, store: MultiremiStore, workspaceId: string): string {
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (member) return member.role;
  // No real member: only the no-identity admin path (master token / open mode)
  // is treated as local owner. A logged-in non-member is NOT auto-"member".
  if (workspaceId === "local" && authenticatedRequestUserId(c) === null) return "owner";
  return "member";
}

/**
 * A caller may receive the PLAINTEXT relay token on daemon bootstrap responses
 * only if a non-task identity maps to a workspace owner/admin. Relay credentials
 * authorize a machine and are not part of task-to-owner workspace parity.
 */
export function callerCanReceiveRelay(c: Context, store: MultiremiStore, workspaceId: string): boolean {
  if (currentAccessToken(c)?.type === "task") return false;
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  return role === "owner" || role === "admin";
}

/** owner/admin actor gate for workspace-scoped configuration. */
export function requireWorkspaceAdmin(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
  if (currentAccessToken(c)?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  if (role === "owner" || role === "admin") return null;
  return c.json({ error: "insufficient permissions" }, 403);
}

/** Sensitive privilege configuration must never be delegated to an agent task. */
export function requireHumanWorkspaceAdmin(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
  const token = currentAccessToken(c);
  if (token?.type === "task" || token?.type === "daemon") {
    return c.json({
      error: "this endpoint requires a human workspace administrator",
      code: "human_admin_required",
    }, 403);
  }
  return requireWorkspaceAdmin(c, store, workspaceId);
}

export function loadCurrentWorkspaceMember(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
): { member: MultiremiWorkspaceMember } | Response {
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const workspace = workspaceId === "local" ? store.ensureLocalWorkspace() : store.getWorkspace(workspaceId);
  if (!workspace) return c.json({ error: "workspace not found" }, 404);
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (!member) return c.json({ error: "workspace not found" }, 404);
  return { member };
}

export function loadCurrentWorkspaceRole(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  roles: Array<"owner" | "admin" | "member">,
): { member: MultiremiWorkspaceMember } | Response {
  const loaded = loadCurrentWorkspaceMember(c, store, workspaceId);
  if (loaded instanceof Response) return loaded;
  if (!roles.includes(loaded.member.role as "owner" | "admin" | "member")) {
    return c.json({ error: "insufficient permissions" }, 403);
  }
  return loaded;
}

export function denyCurrentUserWorkspaceAccess(c: Context, store: MultiremiStore, workspaceId: string): Response | null {
  const token = currentAccessToken(c);
  if (token?.type === "daemon") return c.json({ error: "forbidden for daemon token" }, 403);
  const userId = authenticatedRequestUserId(c);
  // Tokens bound to one workspace (task tokens, user-less workspace PATs) can't
  // reach others. A human's login PAT is minted under "local" but is a session
  // credential, not a scope — the membership check below is the authority for
  // real users, otherwise they could never open a workspace created after login.
  const humanPat = token?.type === "pat" && userId && userId !== "local";
  if (!humanPat && token?.workspaceId && token.workspaceId !== workspaceId) {
    return c.json({ error: "workspace not found" }, 404);
  }
  // Any authenticated human (login PAT or JWT) must be a member of the workspace;
  // non-members get 404 (existence hidden). No user id (or the synthetic "local"
  // admin identity carried by user-less workspace access tokens) => master token /
  // open mode => full admin access.
  if (userId && userId !== "local" && !store.getUserRoleInWorkspace(userId, workspaceId)) {
    return c.json({ error: "workspace not found" }, 404);
  }
  return null;
}

// Pins are private to their owner. When the request is authenticated as a real
// user, the pin's user id must equal that user — nobody can read or mutate
// another person's pins. Master-token / open mode (no authenticated user id)
// keeps full access.
export function denyPinOwnerAccess(c: Context, userId: string): Response | null {
  const authUser = authenticatedRequestUserId(c);
  if (authUser && userId !== authUser) return c.json({ error: "forbidden" }, 403);
  return null;
}

export function loadChatSessionForCurrentUser(
  c: Context,
  store: MultiremiStore,
  sessionId: string,
  options: { requireAgentAccess?: boolean } = {},
): { session: MultiremiChatSession } | Response {
  const session = store.getChatSession(sessionId);
  if (!session) return c.json({ error: "chat session not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, session.workspaceId);
  if (denied) return denied;
  if ((session.creatorId ?? "local") !== currentRequestUserId(c)) {
    return c.json({ error: "not your chat session" }, 403);
  }
  if (options.requireAgentAccess !== false && !canCurrentUserAccessChatSessionAgent(c, store, session)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return { session };
}

export function canCurrentUserAccessChatSessionAgent(
  c: Context,
  store: MultiremiStore,
  session: MultiremiChatSession,
): boolean {
  const agent = store.getAgent(session.agentId);
  return Boolean(agent && agent.workspaceId === session.workspaceId && canCurrentUserAccessAgent(c, store, agent));
}

// Go-style access boundary for reading/serving/deleting an attachment file. Chat
// attachments are private to the chat creator like the chat session itself; issue,
// comment, and free-standing attachments are scoped to the attachment workspace.
// Returns a denial Response when access is forbidden, or null when allowed.
export function denyAttachmentAccess(c: Context, store: MultiremiStore, attachment: MultiremiAttachment): Response | null {
  if (attachment.chatSessionId) {
    const loaded = loadChatSessionForCurrentUser(c, store, attachment.chatSessionId, { requireAgentAccess: false });
    return loaded instanceof Response ? loaded : null;
  }
  if (attachment.commentId) {
    const denied = denyCurrentUserCommentAccess(c, store, attachment.commentId);
    if (denied) return denied;
  }
  return denyCurrentUserWorkspaceAccess(c, store, attachment.workspaceId);
}

export function hasJwtWorkspaceAccess(store: MultiremiStore, userId: string, workspaceId: string): boolean {
  return store.getUserRoleInWorkspace(userId, workspaceId) !== null;
}

export type DaemonWorkspaceDenyOptions = {
  hideForbiddenAsNotFound?: boolean;
};

export function isDaemonGcCheckRequest(c: Context): boolean {
  return new URL(c.req.url).pathname.endsWith("/gc-check");
}

export function denyDaemonTokenWorkspace(c: Context, workspaceId?: string | null, options: DaemonWorkspaceDenyOptions = {}): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const targetWorkspaceId = cleanString(workspaceId) ?? "local";
  if (token.workspaceId === targetWorkspaceId) return null;
  if (options.hideForbiddenAsNotFound) return c.json({ error: "not found" }, 404);
  return c.json({ error: "forbidden for daemon token workspace" }, 403);
}

export function denyDaemonTokenRuntimeWorkspace(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  return denyDaemonTokenWorkspace(c, runtime.workspaceId ?? "local", options);
}

/**
 * Runtime mutation guard for a daemon credential. Workspace scope alone is not
 * enough: every daemon token is a machine identity and may only mutate the
 * runtimes registered by that same daemon.
 */
export function denyDaemonTokenRuntimeIdentity(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  const workspaceDenied = denyDaemonTokenWorkspace(c, runtime.workspaceId ?? "local", options);
  if (workspaceDenied) return workspaceDenied;
  const tokenDaemonId = cleanString(token.daemonId);
  const runtimeDaemonId = cleanString(runtime.daemonId);
  if (!tokenDaemonId || !runtimeDaemonId || tokenDaemonId !== runtimeDaemonId) {
    if (options.hideForbiddenAsNotFound) return c.json({ error: "runtime not found" }, 404);
    return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
  }
  return null;
}

/**
 * Strict authority boundary for Runtime-observed state. A bound daemon token
 * must own the Runtime. The deployment master token and auth-disabled open
 * mode remain compatible with the historical daemon bootstrap flow, while
 * human JWT/PAT and task credentials are rejected.
 *
 * Legacy unbound tokens must first be atomically bound by a Runtime registration;
 * observed state itself never accepts a workspace-wide daemon credential.
 */
export function denyDaemonRuntimeObservedStateAccess(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  authToken?: string | null,
): Response | null {
  const token = currentAccessToken(c);
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found", code: "runtime_not_found" }, 404);
  if (!token) {
    if (!authToken || c.req.header("Authorization") === `Bearer ${authToken}`) return null;
    return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
  }
  if (token.type !== "daemon") {
    return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
  }
  const workspaceDenied = denyDaemonTokenWorkspace(c, runtime.workspaceId ?? "local");
  if (workspaceDenied) return workspaceDenied;
  const tokenDaemonId = cleanString(token.daemonId);
  const runtimeDaemonId = cleanString(runtime.daemonId);
  if (!tokenDaemonId || !runtimeDaemonId || tokenDaemonId !== runtimeDaemonId) {
    return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
  }
  return null;
}

/** Bind a legacy token on first registration, or reject an identity switch. */
export function bindDaemonTokenIdentityOrDeny(
  c: Context,
  store: MultiremiStore,
  daemonId?: string | null,
): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const normalizedDaemonId = cleanString(daemonId);
  if (!normalizedDaemonId || !store.bindDaemonAccessToken(token.id, normalizedDaemonId)) {
    return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
  }
  return null;
}

export function denyDaemonTokenTaskRuntimeIdentity(
  c: Context,
  store: MultiremiStore,
  taskId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  const token = currentAccessToken(c);
  if (token?.type !== "daemon") return null;
  const task = store.getTask(taskId);
  if (!task) return c.json({ error: "task not found" }, 404);
  const workspaceDenied = denyDaemonTokenWorkspace(c, task.workspaceId, options);
  if (workspaceDenied) return workspaceDenied;
  const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
  if (runtime) {
    const runtimeWorkspaceDenied = denyDaemonTokenWorkspace(c, runtime.workspaceId ?? "local", options);
    if (runtimeWorkspaceDenied) return runtimeWorkspaceDenied;
  }
  const tokenDaemonId = cleanString(token.daemonId);
  const runtimeDaemonId = cleanString(runtime?.daemonId);
  if (!tokenDaemonId || !runtimeDaemonId || tokenDaemonId !== runtimeDaemonId) {
    if (options.hideForbiddenAsNotFound) return c.json({ error: "task not found" }, 404);
    return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
  }
  return null;
}

export function denyDaemonTokenIssueWorkspace(
  c: Context,
  store: MultiremiStore,
  issueId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const issue = store.getIssue(issueId);
  if (!issue) return c.json({ error: "issue not found" }, 404);
  return denyDaemonTokenWorkspace(c, issue.workspaceId, options);
}

export function denyDaemonTokenChatSessionWorkspace(
  c: Context,
  store: MultiremiStore,
  sessionId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const session = store.getChatSession(sessionId);
  if (!session) return c.json({ error: "chat session not found" }, 404);
  return denyDaemonTokenWorkspace(c, session.workspaceId, options);
}

export function denyDaemonTokenAutopilotRunWorkspace(
  c: Context,
  store: MultiremiStore,
  runId: string,
  options: DaemonWorkspaceDenyOptions = {},
): Response | null {
  if (currentAccessToken(c)?.type !== "daemon") return null;
  const run = store.getAutopilotRun(runId);
  if (!run) return c.json({ error: "autopilot run not found" }, 404);
  const task = run.taskId ? store.getTask(run.taskId) : null;
  if (task) return denyDaemonTokenWorkspace(c, task.workspaceId, options);
  const issue = run.issueId ? store.getIssue(run.issueId) : null;
  if (issue) return denyDaemonTokenWorkspace(c, issue.workspaceId, options);
  const autopilot = store.getAutopilot(run.autopilotId);
  if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
  return denyDaemonTokenWorkspace(c, autopilot.workspaceId, options);
}
