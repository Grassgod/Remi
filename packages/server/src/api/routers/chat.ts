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
import {
  CHAT_ORIGIN_FILTERS,
  ChatConflictError,
  ChatValidationError,
  type ChatOriginFilter,
} from "@multiremi/store/repos/chat-repo.js";
import { BackgroundTaskError } from "@multiremi/store/repos/background-tasks-repo.js";
import { currentWorkspaceMember } from "../wire/context.js";

export function registerChatRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  // Feishu conversations share transport storage with Chat, but belong to
  // Feishu — an Issue topic to the Issue discussion surface, a private Feishu
  // thread to Feishu itself — never to the user's Web conversation list.
  const listedSessions = (c: Context, workspaceId: string, origin: ChatOriginFilter): MultiremiChatSession[] => {
    const sessions = store.listChatSessions(workspaceId, {
      origin,
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

  // Automation-opened Chats stay out of the default list; `origin=all` or `automation` shows them.
  const requestedOrigin = (c: Context): ChatOriginFilter | Response => {
    const origin = c.req.query("origin") ?? "user";
    return (CHAT_ORIGIN_FILTERS as readonly string[]).includes(origin)
      ? origin as ChatOriginFilter : c.json({ error: "origin must be user, automation or all" }, 400);
  };

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const origin = requestedOrigin(c);
    if (origin instanceof Response) return origin;
    const sessions = listedSessions(c, workspaceId, origin);
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
  // PR 6: every session response carries its running background tasks, one batched read per response.
  const sessionResponses = (sessions: MultiremiChatSession[]) => {
    const counts = store.countRunningBackgroundTasksBySession(sessions.map(session => session.id));
    return sessions.map(session => chatSessionCompatibilityResponse(session, { runningBackgroundTasks: counts.get(session.id) ?? 0 }));
  };
  const sessionResponse = (session: MultiremiChatSession) => sessionResponses([session])[0]!;

  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const origin = requestedOrigin(c);
    if (origin instanceof Response) return origin;
    return c.json(sessionResponses(listedSessions(c, workspaceId, origin)));
  });
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json(sessionResponse(store.createChatSession(input)), 201));
  });
  app.get("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json(sessionResponse(loaded.session));
  });
  app.patch("/api/chat/sessions/:sessionId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json(sessionResponse(store.updateChatSession(loaded.session.id, body))));
  });
  /**
   * PR 6 §7: the session's background tasks, from the registry (no trace
   * read): the running and paused rows, `unknown` ones, then the last 20 that
   * ended. `{session_id, running, rows}`, the shape `chat:background_tasks`
   * patches.
   */
  app.get("/api/chat/sessions/:sessionId/background-tasks", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listSessionBackgroundTasks(loaded.session.id));
  });
  /**
   * ADR 0025: the agent's command catalogue for the Chat menu,
   * `ChatSlashCommandsResponse`. With `session_id`, the Chat's own (only its
   * creator, like reading the Chat; `agent_id` may be left out); without it,
   * a Chat not created yet with `agent_id` (any member who may chat with the
   * agent). The blocked and hidden commands are already taken out.
   */
  app.get("/api/chat/slash-commands", (c) => {
    const sessionId = c.req.query("session_id")?.trim() || null;
    let agentId = c.req.query("agent_id")?.trim() || null;
    if (sessionId) {
      const loaded = loadChatSessionForCurrentUser(c, store, sessionId);
      if (loaded instanceof Response) return loaded;
      if (agentId && agentId !== loaded.session.agentId) return c.json({ error: "agent_id is not this chat session's agent" }, 400);
      agentId = loaded.session.agentId;
    }
    if (!agentId) return c.json({ error: "agent_id or session_id is required" }, 400);
    const agent = store.getAgent(agentId);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    if (!sessionId) {
      const denied = denyCurrentUserWorkspaceAccess(c, store, agent.workspaceId);
      if (denied) return denied;
      if (!canCurrentUserAccessAgentChecker(c, store)(agent)) return c.json({ error: "you do not have access to this agent" }, 403);
    }
    return c.json(store.getChatSlashCommands({ agent, userId: currentRequestUserId(c), sessionId }));
  });
  /**
   * PR 6 §6.1: stop one running task (`{task_id}`: the row's `task_id` or
   * `id`) or all of them (`{all: true}`). Only the Chat's creator. 202 with
   * the request time and the rows it marked; 409 `task_not_running` when no
   * matching task runs, 409 `runtime_offline` when its computer is offline.
   * The daemon answers through its next snapshot.
   */
  app.post("/api/chat/sessions/:sessionId/background-tasks/stop", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<{ task_id?: unknown; all?: unknown }>(c);
    const all = body.all === true;
    const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
    if (all === Boolean(taskId) || taskId.length > 512 || (body.all !== undefined && typeof body.all !== "boolean")) {
      return c.json({ error: "send either task_id or all: true", code: "invalid_request" }, 400);
    }
    try {
      const result = store.requestBackgroundTaskStop(loaded.session.id, all ? { all: true } : { taskId },
        currentWorkspaceMember(c, store, loaded.session.workspaceId)?.id ?? null);
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof BackgroundTaskError && (error.code === "task_not_running" || error.code === "runtime_offline")) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
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
