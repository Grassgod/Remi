/**
 * Chat depth routes — port of the Go chat handlers the widget needs beyond the
 * basic list/create/messages already in routes/chat.ts:
 *
 *   GET /api/chat/sessions/{sessionId}               (h.GetChatSession)
 *   GET /api/chat/sessions/{sessionId}/messages/page (h.ListChatMessagesPage)
 *   GET /api/chat/sessions/{sessionId}/pending-task  (h.GetPendingChatTask)
 *
 * Declares absolute paths → mount at "/". Behind the /api/* JWT gate; scoped
 * to a workspace via X-Workspace-ID (or the resolved wsId context) + a
 * membership check. Session access mirrors Go loadChatSessionForUser: the
 * session must exist in the workspace (404) AND belong to the caller (403
 * "not your chat session" — sessions are private to their creator). The Go
 * private-agent gate (canAccessPrivateAgent) is not ported, consistent with
 * the rest of the Bun chat surface.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getChatSessionInWorkspace, type ChatSession } from "../../db/queries/chat.js";
import {
  getPendingChatTask,
  listAttachmentsByChatMessageIds,
  listChatMessagesPage,
  type AttachmentRow,
  type ChatMessageRow,
  type ChatMessagesCursor,
} from "../../db/queries/chatDepth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts both timestamp formats that legitimately round-trip through the
 * cursor: the PG text form this server emits ("2026-06-10 04:54:19.556828+00")
 * and RFC3339(Nano) ("2026-06-10T04:54:19.556828123Z") as the Go server
 * emitted. Postgres parses either; the regex keeps garbage away from the
 * ::timestamptz cast (which would 500 instead of 400).
 */
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/i;

/** Mirrors the Go ChatSessionResponse struct (snake_case JSON). */
function chatSessionToResponse(s: ChatSession) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    agent_id: s.agentId,
    creator_id: s.creatorId,
    title: s.title,
    status: s.status,
    has_unread: s.unreadSince != null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors the Go AttachmentResponse struct (snake_case JSON; no signer in the
 *  Bun port, so download_url is always the server-relative metadata path). */
function attachmentToResponse(a: AttachmentRow) {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    issue_id: a.issueId,
    comment_id: a.commentId,
    chat_session_id: a.chatSessionId,
    chat_message_id: a.chatMessageId,
    uploader_type: a.uploaderType,
    uploader_id: a.uploaderId,
    filename: a.filename,
    url: a.url,
    download_url: `/api/attachments/${a.id}/download`,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt,
  };
}

/** Mirrors the Go ChatMessageResponse struct. `attachments` carries Go's
 *  omitempty: the key is absent when the message has none. */
function chatMessageToResponse(m: ChatMessageRow, attachments: AttachmentRow[]) {
  return {
    id: m.id,
    chat_session_id: m.chatSessionId,
    role: m.role,
    content: m.content,
    task_id: m.taskId,
    created_at: m.createdAt,
    failure_reason: m.failureReason,
    elapsed_ms: m.elapsedMs,
    ...(attachments.length > 0 ? { attachments: attachments.map(attachmentToResponse) } : {}),
  };
}

/**
 * Resolve + authorize the workspace for this request (same gate as
 * routes/chat.ts): X-Workspace-ID header or the resolved wsId context →
 * UUID-validate → membership check. 400 missing/malformed, 404 not-a-member.
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

/**
 * Load the session for the caller — mirrors Go loadChatSessionForUser's three
 * failure modes: 400 invalid id, 404 not in this workspace, 403 not the
 * creator (a member cannot read another member's transcript).
 */
async function loadSessionForUser(
  c: Context<AppEnv>,
  db: Db,
  ws: string,
): Promise<ChatSession | Response> {
  const id = c.req.param("sessionId");
  if (!id || !UUID_RE.test(id)) return c.json({ error: "invalid chat session id" }, 400);
  const s = await getChatSessionInWorkspace(db, ws, id);
  if (!s) return c.json({ error: "chat session not found" }, 404);
  if (s.creatorId !== c.get("user").sub) return c.json({ error: "not your chat session" }, 403);
  return s;
}

/**
 * Parse limit / cursor query params — mirrors Go parseChatMessagesPageParams:
 * limit defaults to 50 and must be an integer in [1, 100]; the cursor is
 * both-or-neither (before_created_at + before_id), each strictly validated.
 */
function parsePageParams(
  c: Context<AppEnv>,
): { limit: number; before: ChatMessagesCursor | null } | { error: string } {
  let limit = 50;
  const rawLimit = c.req.query("limit");
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return { error: "invalid limit" };
    }
    limit = parsed;
  }

  const rawCreatedAt = c.req.query("before_created_at") ?? "";
  const rawId = c.req.query("before_id") ?? "";
  if (rawCreatedAt === "" && rawId === "") return { limit, before: null };
  if (rawCreatedAt === "" || rawId === "") return { error: "invalid cursor" };
  if (!CURSOR_TS_RE.test(rawCreatedAt) || Number.isNaN(new Date(rawCreatedAt).getTime())) {
    return { error: "invalid cursor" };
  }
  if (!UUID_RE.test(rawId)) return { error: "invalid cursor" };
  return { limit, before: { createdAt: rawCreatedAt, id: rawId } };
}

export function chatDepthRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/chat/sessions/:sessionId — single session (mirrors h.GetChatSession).
  r.get("/api/chat/sessions/:sessionId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadSessionForUser(c, db, ws);
    if (session instanceof Response) return session;
    return c.json(chatSessionToResponse(session));
  });

  // GET /api/chat/sessions/:sessionId/messages/page — keyset-paged transcript
  // (mirrors h.ListChatMessagesPage). The SQL fetches newest windows first so
  // the empty cursor opens at the recent tail; each window is reversed before
  // serializing so messages stay chronological within the viewport. has_more
  // probes with limit+1; next_cursor points at the window's oldest row and is
  // omitted (Go omitempty) on the final page.
  r.get("/api/chat/sessions/:sessionId/messages/page", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadSessionForUser(c, db, ws);
    if (session instanceof Response) return session;

    const params = parsePageParams(c);
    if ("error" in params) return c.json({ error: params.error }, 400);
    const { limit, before } = params;

    let rows = await listChatMessagesPage(db, session.id, limit + 1, before);
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    // Oldest row of this window (rows are newest-first here) anchors the next
    // page. Compute before reversing — mirrors the Go handler exactly.
    const oldest = rows[rows.length - 1];
    const nextCursor =
      hasMore && oldest ? { created_at: oldest.createdAt, id: oldest.id } : null;
    rows.reverse();

    const attachments = await listAttachmentsByChatMessageIds(
      db,
      ws,
      rows.map((m) => m.id),
    );
    const grouped = new Map<string, AttachmentRow[]>();
    for (const a of attachments) {
      if (!a.chatMessageId) continue;
      const list = grouped.get(a.chatMessageId) ?? [];
      list.push(a);
      grouped.set(a.chatMessageId, list);
    }

    return c.json({
      messages: rows.map((m) => chatMessageToResponse(m, grouped.get(m.id) ?? [])),
      limit,
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });
  });

  // GET /api/chat/sessions/:sessionId/pending-task — the most recent in-flight
  // task, or an empty object when none (mirrors h.GetPendingChatTask; the
  // widget polls this so pending UI state survives refresh / reopen).
  r.get("/api/chat/sessions/:sessionId/pending-task", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const session = await loadSessionForUser(c, db, ws);
    if (session instanceof Response) return session;

    const task = await getPendingChatTask(db, session.id);
    if (!task) return c.json({});
    return c.json({ task_id: task.id, status: task.status, created_at: task.createdAt });
  });

  return r;
}
