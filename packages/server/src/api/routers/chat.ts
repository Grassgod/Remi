import type { Context, Hono } from "hono";
import {
  canCurrentUserAccessAgentChecker,
  canCurrentUserAccessChatSessionAgent,
  denyCurrentUserWorkspaceAccess,
  loadChatSessionForCurrentUser,
  normalizeSendChatMessageInput,
  readJson,
  requestedChatWorkspaceId,
  withChatSessionRequestContext,
} from "../helpers.js";
import {
  currentTaskAccessToken,
  chatMessageCompatibilityResponse,
  chatSessionCompatibilityResponse,
  currentRequestUserId,
  sendChatMessageCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type {
  CreateChatSessionInput,
  MultiremiChatSession,
  SendChatMessageInput,
  UpdateChatSessionInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { ChatConflictError, ChatValidationError } from "@multiremi/store/repos/chat-repo.js";

export function registerChatRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  // Feishu conversations share transport storage with Chat, but belong to
  // Feishu — an Issue topic to the Issue discussion surface, a private Feishu
  // thread to Feishu itself — never to the user's Web conversation list.
  const listedSessions = (c: Context, workspaceId: string): MultiremiChatSession[] => {
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
      excludeTransportSessions: true,
    });
    const agentsById = new Map(store.listAgentsLiteByIds(sessions.map(session => session.agentId))
      .map(agent => [agent.id, agent]));
    const canAccess = canCurrentUserAccessAgentChecker(c, store);
    return sessions.filter(session => {
      const agent = agentsById.get(session.agentId);
      return (c.req.query("status") !== "archived" || session.status === "archived")
        && Boolean(agent && agent.workspaceId === session.workspaceId && canAccess(agent));
    });
  };

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sessions = listedSessions(c, workspaceId);
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multiremi/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json({ session: store.createChatSession(input) }, 201));
  });
  app.get("/api/multiremi/chats/:id", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { session } = loaded;
    return c.json({ session, messages: store.listChatMessagesFromLog(session.id) });
  });
  app.patch("/api/multiremi/chats/:id", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json({ session: store.updateChatSession(loaded.session.id, body) }));
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(listedSessions(c, workspaceId).map(chatSessionCompatibilityResponse));
  });
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json(chatSessionCompatibilityResponse(store.createChatSession(input)), 201));
  });
  app.get("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json(chatSessionCompatibilityResponse(loaded.session));
  });
  app.patch("/api/chat/sessions/:sessionId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json(chatSessionCompatibilityResponse(store.updateChatSession(loaded.session.id, body))));
  });
  app.delete("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"), { requireAgentAccess: false });
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteChatSession(loaded.session.id);
    if (!deleted) return c.json({ error: "chat session not found" }, 404);
    return c.body(null, 204);
  });
}

function chatMutation(c: Context, operation: () => Response): Response {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ChatConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof ChatValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
}

function invalidChatUpdate(c: Context, input: UpdateChatSessionInput): Response | null {
  if ("projectId" in input || "project_id" in input) return c.json({ error: "A Chat Project can only be selected when creating the session" }, 400);
  if ("issueId" in input || "issue_id" in input) return c.json({ error: "Chat sessions do not support Issue binding" }, 400);
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) return c.json({ error: "title is required" }, 400);
  if (input.status !== undefined && input.status !== "active" && input.status !== "archived") return c.json({ error: "invalid status" }, 400);
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") return c.json({ error: "pinned must be a boolean" }, 400);
  return null;
}
