// Realtime plumbing for the Multiremi HTTP API: the daemon/browser WebSocket
// client registries, the notify/broadcast fan-out and the upgrade/auth-frame
// authorizers. Moved verbatim out of api/helpers.ts by the D5 split; the
// WebSocket upgrade wiring itself stays in api/server.ts.
import {
  canUserViewTaskMessages,
  hasJwtWorkspaceAccess,
  isDaemonOwnerWorkspaceMember,
  isDaemonTokenAllowedRequest,
  isPendingForRuntime,
  verifyJwtToken,
} from "./helpers.js";
import type {
  BrowserScopeWebSocketRegistry,
  BrowserUserWebSocketRegistry,
  BrowserWebSocketRegistry,
  DaemonWebSocketRegistry,
  MultiremiWebSocketClient,
} from "./helpers.js";
import {
  cleanString,
  taskMessageRealtimePayload,
  taskRealtimePayload,
} from "./wire/index.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type {
  MultiremiAccessToken,
  MultiremiTask,
  MultiremiTaskMessage,
} from "@multiremi/contracts/types.js";

export function registerDaemonWebSocketClient(registry: DaemonWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "daemon") return;
  for (const runtimeId of client.data.runtimeIds) {
    let clients = registry.get(runtimeId);
    if (!clients) {
      clients = new Set();
      registry.set(runtimeId, clients);
    }
    clients.add(client);
  }
}

export function unregisterDaemonWebSocketClient(registry: DaemonWebSocketRegistry, client: MultiremiWebSocketClient): void {
  if (client.data.kind !== "daemon") return;
  for (const runtimeId of client.data.runtimeIds) {
    const clients = registry.get(runtimeId);
    if (!clients) continue;
    clients.delete(client);
    if (clients.size === 0) registry.delete(runtimeId);
  }
}

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

export function handleBrowserScopeSubscribe(
  registry: BrowserScopeWebSocketRegistry,
  store: MultiremiStore,
  client: MultiremiWebSocketClient,
  event: Record<string, any>,
): void {
  const payload = parseBrowserScopePayload(event);
  if (!payload) {
    sendBrowserScopeFrame(client, "subscribe_error", "", "", "invalid payload");
    return;
  }
  const authorized = authorizeBrowserScope(store, client, payload.scope, payload.id);
  if (!authorized.ok) {
    sendBrowserScopeFrame(client, "subscribe_error", payload.scope, payload.id, authorized.error);
    return;
  }
  if (payload.scope === "task" || payload.scope === "chat") {
    registerBrowserScopeWebSocketClient(registry, client, payload.scope, payload.id);
  }
  sendBrowserScopeFrame(client, "subscribe_ack", payload.scope, payload.id);
}

export function handleBrowserScopeUnsubscribe(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  event: Record<string, any>,
): void {
  const payload = parseBrowserScopePayload(event);
  if (payload) unregisterBrowserScopeWebSocketClient(registry, client, payload.scope, payload.id);
  sendBrowserScopeFrame(client, "unsubscribe_ack", payload?.scope ?? "", payload?.id ?? "");
}

export function parseBrowserScopePayload(event: Record<string, any>): { scope: string; id: string } | null {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const scope = cleanString(payload.scope);
  const id = cleanString(payload.id);
  return scope && id ? { scope, id } : null;
}

export function authorizeBrowserScope(
  store: MultiremiStore,
  client: MultiremiWebSocketClient,
  scope: string,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (client.data.kind !== "browser" || !client.data.authenticated) return { ok: false, error: "forbidden" };
  if (scope === "workspace") return id === client.data.workspaceId ? { ok: true } : { ok: false, error: "forbidden" };
  if (scope === "user") return id === client.data.userId ? { ok: true } : { ok: false, error: "forbidden" };
  if (scope === "task") {
    const task = store.getTask(id);
    if (!task || task.workspaceId !== client.data.workspaceId) return { ok: false, error: "forbidden" };
    // Chat-creator + private-agent visibility both live in canUserViewTaskMessages.
    return canUserViewTaskMessages(store, client.data.userId, task) ? { ok: true } : { ok: false, error: "forbidden" };
  }
  if (scope === "chat") {
    const session = store.getChatSession(id);
    if (!session || session.workspaceId !== client.data.workspaceId) return { ok: false, error: "forbidden" };
    return session.creatorId === client.data.userId ? { ok: true } : { ok: false, error: "forbidden" };
  }
  return { ok: false, error: "unknown_scope" };
}

export function registerBrowserScopeWebSocketClient(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  scope: string,
  id: string,
): void {
  if (client.data.kind !== "browser" || !client.data.authenticated) return;
  const key = browserScopeKey(scope, id);
  let clients = registry.get(key);
  if (!clients) {
    clients = new Set();
    registry.set(key, clients);
  }
  clients.add(client);
  if (!client.data.scopeSubscriptions.includes(key)) client.data.scopeSubscriptions.push(key);
}

export function unregisterBrowserScopeWebSocketClient(
  registry: BrowserScopeWebSocketRegistry,
  client: MultiremiWebSocketClient,
  scope?: string,
  id?: string,
): void {
  if (client.data.kind !== "browser") return;
  const keys = scope && id ? [browserScopeKey(scope, id)] : [...client.data.scopeSubscriptions];
  for (const key of keys) {
    const clients = registry.get(key);
    if (!clients) continue;
    clients.delete(client);
    if (clients.size === 0) registry.delete(key);
  }
  client.data.scopeSubscriptions = client.data.scopeSubscriptions.filter((key) => !keys.includes(key));
}

export function browserScopeKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

export function sendBrowserScopeFrame(
  client: MultiremiWebSocketClient,
  type: "subscribe_ack" | "subscribe_error" | "unsubscribe_ack",
  scope: string,
  id: string,
  error?: string,
): void {
  const payload: Record<string, string> = { scope, id };
  if (error) payload.error = error;
  client.sendText(JSON.stringify({ type, payload }));
}

export function notifyDaemonTaskAvailable(registry: DaemonWebSocketRegistry, store: MultiremiStore, task: MultiremiTask): void {
  if (task.status !== "queued") return;
  const runtimeIds = task.runtimeId ? [task.runtimeId] : [...registry.keys()];
  const seen = new Set<string>();
  for (const runtimeId of runtimeIds) {
    if (seen.has(runtimeId)) continue;
    seen.add(runtimeId);
    const clients = registry.get(runtimeId);
    if (!clients?.size) continue;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime || !isPendingForRuntime(store, runtime, task)) continue;
    const frame = JSON.stringify({
      type: "daemon:task_available",
      payload: {
        runtime_id: runtimeId,
        task_id: task.id,
      },
    });
    for (const client of [...clients]) {
      try {
        client.sendText(frame);
      } catch {
        unregisterDaemonWebSocketClient(registry, client);
        try {
          client.close();
        } catch {
          // Already closed.
        }
      }
    }
  }
}

export function notifyBrowserTaskEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  type: string,
  task: MultiremiTask,
): void {
  const frame = JSON.stringify({
    type,
    payload: taskRealtimePayload(task),
    actor_id: task.agentId,
    actor_type: "agent",
  });
  if (task.chatSessionId) {
    // Chat-linked task state carries private chat content (assistant result text,
    // chat_session_id). Like the chat:* events, route it to the chat creator's
    // chat/task subscriptions instead of broadcasting to every workspace client.
    sendFrameToBrowserScopes(scopeRegistry, frame, [["chat", task.chatSessionId], ["task", task.id]]);
    return;
  }
  notifyBrowserWorkspaceClients(workspaceRegistry, task.workspaceId, frame);
}

// Broadcast one task-message frame per persisted row. Mirrors notifyBrowserTaskEvent's
// routing, but every recipient is filtered through canUserViewTaskMessages so a
// private-agent task's raw input/diff/output can't leak to non-owners on the
// workspace-wide broadcast path.
export function notifyBrowserTaskMessages(
  store: MultiremiStore,
  workspaceRegistry: BrowserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  task: MultiremiTask,
  messages: MultiremiTaskMessage[],
): void {
  for (const message of messages) {
    const frame = JSON.stringify({
      type: "task:message",
      payload: taskMessageRealtimePayload(message, task),
      actor_id: task.agentId,
      actor_type: "agent",
    });
    if (task.chatSessionId) {
      // Chat tasks: only the creator's chat/task subscriptions (authorized on subscribe).
      sendFrameToBrowserScopes(scopeRegistry, frame, [["chat", task.chatSessionId], ["task", task.id]]);
      continue;
    }
    sendFrameToBrowserWorkspaceClientsFiltered(workspaceRegistry, task.workspaceId, frame, (client) =>
      canUserViewTaskMessages(store, client.data.kind === "browser" ? client.data.userId : null, task),
    );
  }
}

export function sendFrameToBrowserWorkspaceClientsFiltered(
  registry: BrowserWebSocketRegistry,
  workspaceId: string,
  frame: string,
  allow: (client: MultiremiWebSocketClient) => boolean,
): void {
  const clients = registry.get(workspaceId);
  if (!clients?.size) return;
  for (const client of [...clients]) {
    if (!allow(client)) continue;
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

export function notifyBrowserWorkspaceEvent(
  workspaceRegistry: BrowserWebSocketRegistry,
  userRegistry: BrowserUserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  event: {
    type: string;
    workspaceId: string;
    chatSessionId?: string;
    payload: Record<string, unknown>;
    actorType?: string;
    actorId?: string | null;
  },
): void {
  const frame = JSON.stringify({
    type: event.type,
    payload: event.payload,
    actor_id: event.actorId ?? null,
    actor_type: event.actorType ?? "member",
  });
  if (isChatRealtimeEvent(event.type)) {
    const chatSessionId = chatEventSessionId(event);
    if (chatSessionId) notifyBrowserScopeClients(scopeRegistry, "chat", chatSessionId, frame);
    return;
  }
  if (event.type === "invitation:created" || event.type === "invitation:revoked") {
    const inviteeUserId = invitationEventInviteeUserId(event.payload);
    if (inviteeUserId) notifyBrowserUserEvent(userRegistry, inviteeUserId, frame);
    return;
  }
  notifyBrowserWorkspaceClients(workspaceRegistry, event.workspaceId, frame);
  if (event.type === "member:added") {
    const userId = memberAddedEventUserId(event.payload);
    if (userId) notifyBrowserUserEvent(userRegistry, userId, frame, event.workspaceId);
  }
}

export function isChatRealtimeEvent(type: string): boolean {
  return type === "chat:message"
    || type === "chat:done"
    || type === "chat:session_read"
    || type === "chat:session_deleted"
    || type === "chat:session_updated";
}

export function chatEventSessionId(event: {
  chatSessionId?: string;
  payload: Record<string, unknown>;
}): string | null {
  if (event.chatSessionId) return event.chatSessionId;
  const raw = event.payload.chat_session_id;
  return typeof raw === "string" && raw ? raw : null;
}

export function notifyBrowserScopeClients(
  registry: BrowserScopeWebSocketRegistry,
  scope: string,
  id: string,
  frame: string,
): void {
  const clients = registry.get(browserScopeKey(scope, id));
  if (!clients?.size) return;
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterBrowserScopeWebSocketClient(registry, client, scope, id);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

// Deliver one frame across several scope subscriptions without double-sending to a
// client subscribed to more than one of them (e.g. both the chat and its task scope).
export function sendFrameToBrowserScopes(
  registry: BrowserScopeWebSocketRegistry,
  frame: string,
  keys: Array<[scope: string, id: string]>,
): void {
  const delivered = new Set<MultiremiWebSocketClient>();
  for (const [scope, id] of keys) {
    const clients = registry.get(browserScopeKey(scope, id));
    if (!clients?.size) continue;
    for (const client of [...clients]) {
      if (delivered.has(client)) continue;
      delivered.add(client);
      try {
        client.sendText(frame);
      } catch {
        unregisterBrowserScopeWebSocketClient(registry, client, scope, id);
        try {
          client.close();
        } catch {
          // Already closed.
        }
      }
    }
  }
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

export function notifyDaemonTaskEvent(registry: DaemonWebSocketRegistry, type: string, task: MultiremiTask): void {
  if (!task.runtimeId) return;
  const clients = registry.get(task.runtimeId);
  if (!clients?.size) return;
  const payload: Record<string, unknown> = {
    task_id: task.id,
    agent_id: task.agentId,
    issue_id: task.issueId,
    runtime_id: task.runtimeId,
    workspace_id: task.workspaceId,
    status: task.status,
  };
  if (task.chatSessionId) payload.chat_session_id = task.chatSessionId;
  if (task.autopilotRunId) payload.autopilot_run_id = task.autopilotRunId;
  if (task.waitReason) payload.wait_reason = task.waitReason;
  const frame = JSON.stringify({ type, payload });
  for (const client of [...clients]) {
    try {
      client.sendText(frame);
    } catch {
      unregisterDaemonWebSocketClient(registry, client);
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export async function authorizeDaemonWebSocketRequest(
  req: Request,
  store: MultiremiStore,
  authToken: string,
  runtimeIds: string[],
): Promise<
  | {
      accessToken: MultiremiAccessToken | null;
      canReportAgentPluginProtocol: boolean;
    }
  | { response: Response }
> {
  let accessToken: MultiremiAccessToken | null = null;
  const token = bearerToken(req);
  if (token && token !== authToken) {
    accessToken = await store.verifyAccessToken(token);
    if (!accessToken) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    if (accessToken.type === "daemon" && !isDaemonTokenAllowedRequest(req)) {
      return { response: Response.json({ error: "forbidden for daemon token" }, { status: 403 }) };
    }
    if (accessToken.type !== "daemon") {
      return {
        response: Response.json(
          { error: "daemon token required", code: "daemon_token_required" },
          { status: 403 },
        ),
      };
    }
    if (!cleanString(accessToken.daemonId)) {
      return {
        response: Response.json(
          { error: "forbidden for daemon identity", code: "daemon_identity_forbidden" },
          { status: 403 },
        ),
      };
    }
    if (!isDaemonOwnerWorkspaceMember(store, accessToken)) {
      return {
        response: Response.json(
          {
            error: "daemon owner is no longer a workspace member",
            code: "daemon_owner_membership_required",
          },
          { status: 403 },
        ),
      };
    }
  } else if (authToken && token !== authToken) {
    return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  }

  for (const runtimeId of runtimeIds) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return { response: Response.json({ error: "runtime not found" }, { status: 404 }) };
    if (accessToken?.type === "daemon" && (runtime.workspaceId ?? "local") !== accessToken.workspaceId) {
      return { response: Response.json({ error: "forbidden for daemon token workspace" }, { status: 403 }) };
    }
    if (accessToken?.type === "daemon") {
      const tokenDaemonId = cleanString(accessToken.daemonId);
      const runtimeDaemonId = cleanString(runtime.daemonId);
      if (!tokenDaemonId || !runtimeDaemonId || runtimeDaemonId !== tokenDaemonId) {
        return { response: Response.json({ error: "runtime not found" }, { status: 404 }) };
      }
    }
  }
  return {
    accessToken,
    // The deployment-wide master token is the historical daemon credential.
    // Keep it compatible while preventing PAT/JWT websocket clients from
    // rewriting daemon capability metadata. Open mode is trusted as before.
    canReportAgentPluginProtocol:
      !authToken || token === authToken || accessToken?.type === "daemon",
  };
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

export function parseDaemonWebSocketRuntimeIds(url: URL): string[] {
  const runtimeIds: string[] = [];
  const add = (raw: string | null): void => {
    if (raw == null) return;
    for (const part of raw.split(",")) {
      const runtimeId = part.trim();
      if (!runtimeId || runtimeIds.includes(runtimeId)) continue;
      runtimeIds.push(runtimeId);
    }
  };
  for (const raw of url.searchParams.getAll("runtime_id")) add(raw);
  for (const raw of url.searchParams.getAll("runtime_ids")) add(raw);
  return runtimeIds;
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

export function parseDaemonWebSocketHeartbeat(event: Record<string, any>): {
  runtimeId: string | null;
  supportsBatchImport: boolean;
  supportsDirectoryScan: boolean;
  agentPluginProtocol: number | undefined;
} {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
  const runtimeId = cleanString(payload.runtime_id ?? event.runtime_id);
  const protocolValue = Object.prototype.hasOwnProperty.call(payload, "agent_plugin_protocol")
    ? payload.agent_plugin_protocol
    : Object.prototype.hasOwnProperty.call(event, "agent_plugin_protocol")
      ? event.agent_plugin_protocol
      : undefined;
  return {
    runtimeId,
    supportsBatchImport: Boolean(payload.supports_batch_import ?? event.supports_batch_import),
    supportsDirectoryScan: Boolean(payload.supports_directory_scan ?? event.supports_directory_scan),
    agentPluginProtocol: protocolValue === undefined
      ? undefined
      : normalizeProtocolVersion(protocolValue),
  };
}

function normalizeProtocolVersion(value: unknown): number {
  const protocol = Number(value);
  return Number.isSafeInteger(protocol) && protocol >= 0 ? protocol : 0;
}

export function decodeWebSocketMessage(message: BufferSource): string {
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}
