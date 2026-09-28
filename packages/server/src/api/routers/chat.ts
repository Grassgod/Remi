import type { Context, Hono } from "hono";
import {
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
  const isListedSession = (c: Context, session: MultiremiChatSession): boolean =>
    !store.isFeishuTransportChatSession(session.id)
      && canCurrentUserAccessChatSessionAgent(c, store, session);

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
    }).filter((session) => (c.req.query("status") !== "archived" || session.status === "archived") && isListedSession(c, session));
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
    return c.json({ session, messages: store.listChatMessages(session.id) });
  });
  app.patch("/api/multiremi/chats/:id", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json({ session: store.updateChatSession(loaded.session.id, body) }));
  });
  app.get("/api/multiremi/chats/:id/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ messages: store.listChatMessages(loaded.session.id) });
  });
  app.post("/api/multiremi/chats/:id/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return chatMutation(c, () => {
      const result = store.sendChatMessage(loaded.session.id, {
        ...message,
        parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
      });
      return c.json({ ...result, supports_queue: true, task: taskPublicResponse(result.task) }, 201);
    });
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
    }).filter((session) => (c.req.query("status") !== "archived" || session.status === "archived") && isListedSession(c, session)).map(chatSessionCompatibilityResponse));
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
  app.get("/api/chat/sessions/:sessionId/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const messages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(messages.map((message) => message.id));
    return c.json(messages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? [])));
  });
  app.get("/api/chat/sessions/:sessionId/messages/page", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit != null && rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return c.json({ error: "invalid limit" }, 400);
      }
      limit = parsedLimit;
    }
    const beforeCreatedAt = c.req.query("before_created_at");
    const beforeId = c.req.query("before_id");
    if ((!beforeCreatedAt && beforeId) || (beforeCreatedAt && !beforeId)) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    if (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt))) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    const sessionMessages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(sessionMessages.map((message) => message.id));
    const messages = sessionMessages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? []));
    const cursorIndex = beforeCreatedAt
      ? messages.findIndex((message) => message.id === beforeId && message.created_at === beforeCreatedAt)
      : messages.length;
    if (cursorIndex < 0) return c.json({ error: "invalid cursor" }, 400);
    const filtered = messages.slice(0, cursorIndex);
    const pageMessages = filtered.slice(Math.max(0, filtered.length - limit));
    const hasMore = filtered.length > pageMessages.length;
    const nextCursor = hasMore && pageMessages[0]
      ? { created_at: pageMessages[0].created_at, id: pageMessages[0].id }
      : null;
    return c.json({
      messages: pageMessages,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  });
  app.post("/api/chat/sessions/:sessionId/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return chatMutation(c, () => c.json(sendChatMessageCompatibilityResponse(store.sendChatMessage(loaded.session.id, {
      ...message,
      parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
    })), 201));
  });
  app.get("/api/chat/sessions/:sessionId/pending-task", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const task = store.getPendingChatTask(loaded.session.id);
    return c.json({
      ...(task ? { task_id: task.id, status: task.status, created_at: task.createdAt } : {}),
      ...(task?.waitReason ? { wait_reason: task.waitReason } : {}),
      ...(task && !task.issueId && loaded.session.projectId && task.progressSummary
        ? { progress_summary: task.progressSummary } : {}),
      supports_queue: true,
      queued_tasks: store.listQueuedChatTasks(loaded.session.id),
    });
  });
  app.patch("/api/chat/sessions/:sessionId/queue/:taskId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<{ content?: unknown }>(c);
    if (typeof body.content !== "string" || !body.content.trim()) return c.json({ error: "content is required" }, 400);
    return chatMutation(c, () => c.json(store.updateQueuedChatTask(loaded.session.id, c.req.param("taskId"), body.content as string)));
  });
  app.delete("/api/chat/sessions/:sessionId/queue/:taskId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => {
      store.removeQueuedChatTasks(loaded.session.id, c.req.param("taskId"));
      return c.body(null, 204);
    });
  });
  app.delete("/api/chat/sessions/:sessionId/queue", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => {
      store.removeQueuedChatTasks(loaded.session.id);
      return c.body(null, 204);
    });
  });
  app.post("/api/chat/sessions/:sessionId/queue/:taskId/prioritize", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => c.json(store.prioritizeQueuedChatTask(loaded.session.id, c.req.param("taskId"))));
  });
  app.post("/api/chat/sessions/:sessionId/read", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    store.markChatSessionRead(loaded.session.id);
    return c.body(null, 204);
  });
  app.get("/api/chat/pending-tasks", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listPendingChatTasks(workspaceId, { creatorId: currentRequestUserId(c) })
      .filter((task) => {
        const session = task.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
        return session ? isListedSession(c, session) : false;
      })
      .map((task) => ({ task_id: task.id, status: task.status, chat_session_id: task.chatSessionId }));
    return c.json({ tasks });
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
