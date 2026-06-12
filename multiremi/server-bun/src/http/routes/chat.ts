/**
 * Chat routes (read path) — port of the Go chat handler's
 * GET /api/chat/sessions (list the caller's active sessions in the workspace)
 * and GET /api/chat/sessions/:id/messages (the session transcript). Behind the
 * /api/* JWT gate; scoped to a workspace via the X-Workspace-ID header + a
 * membership check (multi-tenancy).
 *
 * Chat sessions are private to their creator. The workspace gate proves the
 * caller belongs to the tenant; the per-session ownership check (creator_id ==
 * user) is what mirrors Go's loadChatSessionForUser — a member cannot read
 * another member's transcript even within the same workspace.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import {
  createChatMessage,
  createChatSession,
  deleteChatSession,
  getChatSessionInWorkspace,
  listChatMessages,
  listChatSessionsByCreator,
  markChatSessionRead,
  touchChatSessionUnread,
  updateChatSession,
  type ChatMessage,
  type ChatSession,
  type ChatSessionListRow,
} from "../../db/queries/chat.js";
import { agentTaskQueue } from "../../db/schema.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go ChatSessionResponse struct (snake_case JSON). Accepts a list
 *  row (carries hasUnread) or a plain session (derive from unread_since). */
function chatSessionToResponse(s: ChatSessionListRow | ChatSession) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    agent_id: s.agentId,
    creator_id: s.creatorId,
    title: s.title,
    status: s.status,
    has_unread: "hasUnread" in s ? s.hasUnread : s.unreadSince != null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors the Go ChatMessageResponse struct (snake_case JSON). */
function chatMessageToResponse(m: ChatMessage) {
  return {
    id: m.id,
    chat_session_id: m.chatSessionId,
    role: m.role,
    content: m.content,
    task_id: m.taskId,
    created_at: m.createdAt,
    failure_reason: m.failureReason,
    elapsed_ms: m.elapsedMs,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

export function chatRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Load a session owned by the caller in the workspace, or short-circuit 404.
  const loadOwnedSession = async (c: Context<AppEnv>, db: Db, ws: string): Promise<ChatSession | Response> => {
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.json({ error: "invalid chat session id" }, 400);
    const s = await getChatSessionInWorkspace(db, ws, id);
    if (!s || s.creatorId !== c.get("user").sub) return c.json({ error: "chat session not found" }, 404);
    return s;
  };

  r.get("/sessions", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const sessions = await listChatSessionsByCreator(db, ws, c.get("user").sub);
    return c.json(sessions.map(chatSessionToResponse));
  });

  // POST /api/chat/sessions — open a session with an agent in the workspace.
  r.post("/sessions", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
    if (!UUID_RE.test(agentId)) return c.json({ error: "agent_id is required" }, 400);
    const ag = await getAgentInWorkspace(db, ws, agentId);
    if (!ag) return c.json({ error: "agent not found" }, 404);
    const title = typeof body.title === "string" ? body.title : "";

    const session = await createChatSession(db, {
      workspaceId: ws,
      agentId: ag.id,
      creatorId: c.get("user").sub,
      title,
      runtimeId: ag.runtimeId,
    });
    bus.publish({ type: "chat_session.created", workspaceId: ws, payload: { id: session.id } });
    return c.json(chatSessionToResponse(session), 201);
  });

  // PATCH /api/chat/sessions/:id — rename / archive (owner-only).
  r.patch("/sessions/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadOwnedSession(c, db, ws);
    if (session instanceof Response) return session;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const fields: { title?: string; status?: string } = {};
    if (typeof body.title === "string") fields.title = body.title;
    if (typeof body.status === "string") {
      if (body.status !== "active" && body.status !== "archived") {
        return c.json({ error: "status must be active or archived" }, 400);
      }
      fields.status = body.status;
    }
    const updated = await updateChatSession(db, session.id, fields);
    bus.publish({ type: "chat_session.updated", workspaceId: ws, payload: { id: session.id } });
    return c.json(chatSessionToResponse(updated ?? session));
  });

  // DELETE /api/chat/sessions/:id — remove the session + its transcript.
  r.delete("/sessions/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadOwnedSession(c, db, ws);
    if (session instanceof Response) return session;
    await deleteChatSession(db, session.id);
    bus.publish({ type: "chat_session.deleted", workspaceId: ws, payload: { id: session.id } });
    return c.body(null, 204);
  });

  r.get("/sessions/:id/messages", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid chat session id" }, 400);

    // Load + authorize: session must exist in the workspace AND be owned by the
    // requesting user (mirrors Go loadChatSessionForUser — creator-only access).
    const session = await getChatSessionInWorkspace(db, ws, id);
    if (!session || session.creatorId !== c.get("user").sub) {
      return c.json({ error: "chat session not found" }, 404);
    }

    const messages = await listChatMessages(db, session.id);
    return c.json(messages.map(chatMessageToResponse));
  });

  // POST /api/chat/sessions/:id/messages — send a user turn; enqueue an agent
  // task bound to the session so the daemon runs it and writes the assistant
  // reply back. The chat analog of the comment-@mention trigger.
  r.post("/sessions/:id/messages", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadOwnedSession(c, db, ws);
    if (session instanceof Response) return session;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return c.json({ error: "content is required" }, 400);

    // The user turn.
    const message = await createChatMessage(db, { chatSessionId: session.id, role: "user", content });

    // Resolve the runtime (session carries it; fall back to the agent's).
    let runtimeId = session.runtimeId;
    if (!runtimeId) {
      const ag = await getAgentInWorkspace(db, ws, session.agentId);
      runtimeId = ag?.runtimeId ?? null;
    }
    let taskId: string | undefined;
    if (runtimeId) {
      const [task] = await db
        .insert(agentTaskQueue)
        .values({ agentId: session.agentId, runtimeId, chatSessionId: session.id, status: "queued" })
        .returning();
      taskId = task?.id;
    }

    await touchChatSessionUnread(db, session.id);
    bus.publish({ type: "chat_message.created", workspaceId: ws, payload: { session_id: session.id, id: message.id } });
    return c.json({ message: chatMessageToResponse(message), task_id: taskId ?? null }, 201);
  });

  // POST /api/chat/sessions/:id/read — clear the unread marker.
  r.post("/sessions/:id/read", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadOwnedSession(c, db, ws);
    if (session instanceof Response) return session;
    await markChatSessionRead(db, session.id);
    return c.body(null, 204);
  });

  return r;
}
