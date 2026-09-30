// Realtime plumbing for the Multiremi HTTP API: the daemon/browser WebSocket
// client registries, the notify/broadcast fan-out and the upgrade/auth-frame
// authorizers. Moved verbatim out of api/helpers.ts by the D5 split; the
// WebSocket upgrade wiring itself stays in api/server.ts.
import { hasJwtWorkspaceAccess, verifyJwtToken } from "./helpers.js";
import type {
  BrowserUserWebSocketRegistry,
  BrowserWebSocketRegistry,
  MultiremiWebSocketClient,
} from "./helpers.js";
import {
  cleanString,
  taskRealtimePayload,
} from "./wire/index.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type {
  MultiremiAccessToken,
  MultiremiTask,
} from "@multiremi/contracts/types.js";


export function registerBrowserWebSocketClient(registry: BrowserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.authenticated) return;
  let clients = registry.get(client.data.workspaceId);
  if (!clients) {
    clients = new Set();
    registry.set(client.data.workspaceId, clients);
  }
  clients.add(client);
}

export function registerBrowserUserWebSocketClient(registry: BrowserUserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.authenticated || !client.data.userId) return;
  let clients = registry.get(client.data.userId);
  if (!clients) {
    clients = new Set();
    registry.set(client.data.userId, clients);
  }
  clients.add(client);
}

export function unregisterBrowserWebSocketClient(registry: BrowserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser") return;
  const clients = registry.get(client.data.workspaceId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) registry.delete(client.data.workspaceId);
}

export function unregisterBrowserUserWebSocketClient(registry: BrowserUserWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "browser" || !client.data.userId) return;
  const clients = registry.get(client.data.userId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) registry.delete(client.data.userId);
}

export function notifyBrowserTaskEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  userRegistry: BrowserUserWebSocketRegistry,
  store: MultiremiStore,
  type: string,
  task: MultiremiTask,
): void {
  const payload = taskRealtimePayload(task);
  if (type === "task:progress") payload.progress_summary = task.progressSummary;
  const frame = JSON.stringify({
    type,
    payload,
    actor_id: task.agentId,
    actor_type: "agent",
  });
  if (task.chatSessionId) {
    const session = store.getChatSession(task.chatSessionId);
    if (session?.creatorId) notifyBrowserUserEventByAudience(userRegistry, session.creatorId,
      { human: frame, restricted: frame }, undefined, task.workspaceId);
    return;
  }
  notifyBrowserWorkspaceClients(workspaceRegistry, task.workspaceId, frame);
}

/**
 * Who owns the chat session an invalidation event is about.
 *
 * The session row is the authority; a deleted session has none left, which is
 * exactly the `chat:session_deleted` case, so the event's own actor is the
 * fallback — `emitChatEvent` stamps the session's creator there
 * (`store/context.ts:833`). `null` means the creator could not be resolved, and
 * the caller drops the event rather than broadcasting private chat state.
 */
export function chatEventCreatorId(
  store: MultiremiStore | null | undefined,
  event: { chatSessionId?: string; payload: Record<string, unknown>; actorId?: string | null },
): string | null {
  const chatSessionId = chatEventSessionId(event);
  if (chatSessionId) {
    const session = store?.getChatSession(chatSessionId);
    if (session?.creatorId) return session.creatorId;
  }
  const actorId = cleanString(event.actorId);
  return actorId || null;
}

export function notifyBrowserWorkspaceEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  userRegistry: BrowserUserWebSocketRegistry,
  event: {
    type: string;
    workspaceId: string;
    chatSessionId?: string;
    payload: Record<string, unknown>;
    actorType?: string;
    actorId?: string | null;
  },
  /**
   * MUL-438: chat lifecycle invalidations need the session's creator, which the
   * event payload does not carry. Only the chat branch reads it; every other
   * caller may omit it.
   */
  options: { store?: MultiremiStore | null } = {},
): void {
  if (event.type.startsWith("chat:") && !isChatRealtimeEvent(event.type)) return;
  const envelope = {
    type: event.type,
    payload: event.payload,
    actor_id: event.actorId ?? null,
    actor_type: event.actorType ?? "member",
  };
  const frames: BrowserWorkspaceEventFrames = {
    human: JSON.stringify(envelope),
    restricted: JSON.stringify({
      ...envelope,
      payload: redactWorkspaceEventPayloadForRestrictedClient(event.payload),
    }),
  };
  if (isChatRealtimeEvent(event.type)) {
    const creatorId = chatEventCreatorId(options.store, event);
    if (creatorId) {
      notifyBrowserUserEventByAudience(userRegistry, creatorId, frames, undefined, event.workspaceId);
    }
    return;
  }
  if (event.type === "invitation:created" || event.type === "invitation:revoked") {
    const inviteeUserId = invitationEventInviteeUserId(event.payload);
    if (inviteeUserId) notifyBrowserUserEventByAudience(userRegistry, inviteeUserId, frames);
    return;
  }
  notifyBrowserWorkspaceClientsByAudience(workspaceRegistry, event.workspaceId, frames);
  if (event.type === "member:added") {
    const userId = memberAddedEventUserId(event.payload);
    if (userId) notifyBrowserUserEventByAudience(userRegistry, userId, frames, event.workspaceId);
  }
}

type BrowserWorkspaceEventFrames = {
  human: string;
  restricted: string;
};

const RESTRICTED_REALTIME_FIELDS = new Set([
  "webhookToken",
  "webhook_token",
  "webhookPath",
  "webhook_path",
  "webhookUrl",
  "webhook_url",
  "signingSecret",
  "signing_secret",
  "signingSecretHash",
  "signing_secret_hash",
  "signingSecretHint",
  "signing_secret_hint",
  "signingSecretSet",
  "signing_secret_set",
  "issueCreationRestricted",
  "issue_creation_restricted",
  "issueCreationRestrictionReason",
  "issue_creation_restriction_reason",
  "issueCreationRestrictedByTaskId",
  "issue_creation_restricted_by_task_id",
]);

export function redactWorkspaceEventPayloadForRestrictedClient(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactWorkspaceEventPayloadForRestrictedClient(item));
  }
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (RESTRICTED_REALTIME_FIELDS.has(key)) continue;
    redacted[key] = redactWorkspaceEventPayloadForRestrictedClient(nested);
  }
  return redacted;
}

function browserWorkspaceEventFrame(
  client: MultiremiWebSocketClient,
  frames: BrowserWorkspaceEventFrames,
): string {
  if (client.data.kind !== "browser") return frames.restricted;
  const tokenType = client.data.accessToken?.type;
  return tokenType == null || tokenType === "pat" ? frames.human : frames.restricted;
}

function notifyBrowserWorkspaceClientsByAudience(
  registry: BrowserWebSocketRegistry,
  workspaceId: string,
  frames: BrowserWorkspaceEventFrames,
): void {
  const clients = registry.get(workspaceId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    try {
      client.sendText(browserWorkspaceEventFrame(client, frames));
    } catch {
      unregisterBrowserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function notifyBrowserUserEventByAudience(
  registry: BrowserUserWebSocketRegistry,
  userId: string,
  frames: BrowserWorkspaceEventFrames,
  excludeWorkspaceId?: string,
  /**
   * MUL-438: when set, only sockets bound to this workspace receive the frame.
   *
   * The user registry is keyed by user, and one user can hold a socket in every
   * workspace they belong to; a private chat invalidation belongs to exactly one
   * of them. Without this a workspace-B tab would be handed a workspace-A
   * session's title.
   */
  onlyWorkspaceId?: string,
): void {
  const clients = registry.get(userId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    if (client.data.kind === "browser" && excludeWorkspaceId && client.data.workspaceId === excludeWorkspaceId) continue;
    if (client.data.kind === "browser" && onlyWorkspaceId && client.data.workspaceId !== onlyWorkspaceId) continue;
    try {
      client.sendText(browserWorkspaceEventFrame(client, frames));
    } catch {
      unregisterBrowserUserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

export function isChatRealtimeEvent(type: string): boolean {
  return type === "chat:done"
    || type === "chat:session_read"
    || type === "chat:session_deleted"
    || type === "chat:session_updated"
    || type === "chat:queue_updated";
}

export function chatEventSessionId(event: {
  chatSessionId?: string;
  payload: Record<string, unknown>;
}): string | null {
  if (event.chatSessionId) return event.chatSessionId;
  const raw = event.payload.chat_session_id;
  return typeof raw === "string" && raw ? raw : null;
}

export function notifyBrowserWorkspaceClients(
  registry: BrowserWebSocketRegistry,
  workspaceId: string,
  frame: string,
): void {
  const clients = registry.get(workspaceId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

export function notifyBrowserUserEvent(
  registry: BrowserUserWebSocketRegistry,
  userId: string,
  frame: string,
  excludeWorkspaceId?: string,
): void {
  const clients = registry.get(userId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    if (client.data.kind === "browser" && excludeWorkspaceId && client.data.workspaceId === excludeWorkspaceId) continue;
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserUserWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

export function invitationEventInviteeUserId(payload: Record<string, unknown>): string | null {
  if (typeof payload.invitee_user_id === "string" && payload.invitee_user_id) return payload.invitee_user_id;
  const invitation = payload.invitation;
  if (invitation && typeof invitation === "object" && "invitee_user_id" in invitation) {
    const inviteeUserId = (invitation as Record<string, unknown>).invitee_user_id;
    return typeof inviteeUserId === "string" && inviteeUserId ? inviteeUserId : null;
  }
  return null;
}

export function memberAddedEventUserId(payload: Record<string, unknown>): string | null {
  const member = payload.member;
  if (!member || typeof member !== "object" || !("user_id" in member)) return null;
  const userId = (member as Record<string, unknown>).user_id;
  return typeof userId === "string" && userId ? userId : null;
}


export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}


export function resolveBrowserWebSocketWorkspaceId(
  store: MultiremiStore,
  url: URL,
): { workspaceId: string } | { response: Response } {
  const byId = cleanString(
    url.searchParams.get("workspace_id")
      ?? url.searchParams.get("workspaceId"),
  );
  if (byId) {
    if (byId === "local") store.ensureLocalWorkspace();
    else if (!store.getWorkspace(byId)) return { response: Response.json({ error: "workspace not found" }, { status: 404 }) };
    return { workspaceId: byId };
  }
  const slug = cleanString(
    url.searchParams.get("workspace_slug")
      ?? url.searchParams.get("workspaceSlug"),
  );
  if (!slug) {
    return { response: Response.json({ error: "workspace_id or workspace_slug required" }, { status: 400 }) };
  }
  if (slug === "local") return { workspaceId: store.ensureLocalWorkspace().id };
  const workspace = store.listWorkspaces().find((candidate) => candidate.slug === slug);
  if (!workspace) return { response: Response.json({ error: "workspace not found" }, { status: 404 }) };
  return { workspaceId: workspace.id };
}

export async function authorizeBrowserWebSocketUpgrade(
  req: Request,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<
  | { authenticated: boolean; userId: string | null; accessToken: MultiremiAccessToken | null }
  | { response: Response }
> {
  const token = bearerToken(req);
  if (!token) return { authenticated: false, userId: null, accessToken: null };
  const authorized = await authorizeBrowserWebSocketToken(token, store, authToken, workspaceId);
  if ("error" in authorized) {
    return { response: Response.json({ error: authorized.error }, { status: authorized.status }) };
  }
  return { authenticated: true, userId: authorized.userId, accessToken: authorized.accessToken };
}

export async function authorizeBrowserWebSocketAuthFrame(
  event: Record<string, any>,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<{ userId: string; accessToken: MultiremiAccessToken | null } | { error: string }> {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const token = cleanString(payload.token);
  if (event.type !== "auth" || !token) return { error: "expected auth message as first frame" };
  const authorized = await authorizeBrowserWebSocketToken(token, store, authToken, workspaceId);
  if ("error" in authorized) return { error: authorized.error };
  return authorized;
}

export async function authorizeBrowserWebSocketToken(
  token: string,
  store: MultiremiStore,
  authToken: string,
  workspaceId: string,
): Promise<
  | { userId: string; accessToken: MultiremiAccessToken | null }
  | { error: string; status: 401 | 403 }
> {
  if (authToken && token === authToken) return { userId: "root", accessToken: null };
  const accessToken = await store.verifyAccessToken(token);
  if (accessToken) {
    if (accessToken.type === "daemon") return { error: "forbidden for daemon token", status: 403 };
    if (accessToken.type === "task") return { error: "forbidden for task token", status: 403 };
    const userId = accessToken.userId || "local";
    // Membership is the sole authority — a token being bound to this workspace
    // does not by itself make its user a member.
    if (!hasJwtWorkspaceAccess(store, userId, workspaceId)) {
      return { error: "not a member of this workspace", status: 403 };
    }
    return { userId, accessToken };
  }
  const jwt = verifyJwtToken(token);
  if (!jwt) return { error: "invalid token", status: 401 };
  if (!hasJwtWorkspaceAccess(store, jwt.userId, workspaceId)) {
    return { error: "not a member of this workspace", status: 403 };
  }
  return { userId: jwt.userId, accessToken: null };
}


export function parseDaemonWebSocketMessage(message: string | BufferSource): Record<string, any> {
  const text = typeof message === "string" ? message : decodeWebSocketMessage(message);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : { type: "message", payload: text };
  } catch {
    return { type: text || "message" };
  }
}

export function decodeWebSocketMessage(message: BufferSource): string {
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}
