import type { Hono } from "hono";
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
  currentWorkspaceMember,
  chatMessageCompatibilityResponse,
  chatSessionCompatibilityResponse,
  currentRequestUserId,
  sendChatMessageCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type {
  CreateChatSessionInput,
  SendChatMessageInput,
  UpdateChatSessionInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { AgentIssueUpdateValidationError } from "@multiremi/store/repos/agent-issue-updates-repo.js";

export function registerChatRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all",
    }).filter((session) => canCurrentUserAccessChatSessionAgent(c, store, session));
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multiremi/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return c.json({ session: store.createChatSession(input) }, 201);
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
    return c.json({ session: store.updateChatSession(loaded.session.id, body) });
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
    const result = store.sendChatMessage(loaded.session.id, {
      ...message,
      parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
    });
    return c.json({ ...result, task: taskPublicResponse(result.task) }, 201);
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all",
    }).filter((session) => canCurrentUserAccessChatSessionAgent(c, store, session)).map(chatSessionCompatibilityResponse));
  });
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return c.json(chatSessionCompatibilityResponse(store.createChatSession(input)), 201);
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
    return c.json(chatSessionCompatibilityResponse(store.updateChatSession(loaded.session.id, body)));
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
    const filtered = beforeCreatedAt
      ? messages.filter((message) =>
        message.created_at < beforeCreatedAt ||
        (message.created_at === beforeCreatedAt && beforeId ? message.id < beforeId : false)
      )
      : messages;
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
    return c.json(sendChatMessageCompatibilityResponse(store.sendChatMessage(loaded.session.id, {
      ...message,
      parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
    })), 201);
  });
  app.get("/api/chat/sessions/:sessionId/pending-task", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const task = store.getPendingChatTask(loaded.session.id);
    return c.json(task ? { task_id: task.id, status: task.status, created_at: task.createdAt } : {});
  });
  app.post("/api/chat/sessions/:sessionId/read", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    store.markChatSessionRead(loaded.session.id);
    return c.body(null, 204);
  });
  app.get("/api/chat/sessions/:sessionId/issue-updates", (c) => {
    if (currentTaskAccessToken(c)) {
      return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
    }
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json({ subscription: agentIssueUpdateSubscriptionResponse(
      store.getAgentIssueUpdateSubscription(loaded.session.id),
    ) });
  });
  app.put("/api/chat/sessions/:sessionId/issue-updates", async (c) => {
    if (currentTaskAccessToken(c)) {
      return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
    }
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<{ enabled?: unknown }>(c);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    try {
      const member = currentWorkspaceMember(c, store, loaded.session.workspaceId);
      const subscription = store.setAgentIssueUpdateSubscription({
        chatSessionId: loaded.session.id,
        enabled: body.enabled,
        memberId: member?.id ?? null,
        createdBy: currentRequestUserId(c),
      });
      return c.json({ subscription: agentIssueUpdateSubscriptionResponse(subscription) });
    } catch (error) {
      if (error instanceof AgentIssueUpdateValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  app.get("/api/chat/pending-tasks", (c) => {
    const workspaceId = requestedChatWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listPendingChatTasks(workspaceId, { creatorId: currentRequestUserId(c) })
      .filter((task) => {
        const session = task.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
        return session ? canCurrentUserAccessChatSessionAgent(c, store, session) : false;
      })
      .map((task) => ({ task_id: task.id, status: task.status, chat_session_id: task.chatSessionId }));
    return c.json({ tasks });
  });
}

function agentIssueUpdateSubscriptionResponse(subscription: import("@multiremi/contracts/types.js").MultiremiAgentIssueUpdateSubscription) {
  return {
    chat_session_id: subscription.chatSessionId,
    issue_id: subscription.issueId,
    channel_id: subscription.channelId,
    enabled: subscription.enabled,
    debounce_window_seconds: subscription.debounceWindowSeconds,
  };
}
