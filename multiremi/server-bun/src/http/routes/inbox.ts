/**
 * Inbox routes (read path) — port of the Go inbox handler's
 * GET /api/inbox (list), GET /api/inbox/unread-count, and
 * POST /api/inbox/:id/read (mark a single item read). Behind the /api/* JWT
 * gate; scoped to a workspace via the X-Workspace-ID header.
 *
 * Note: the inbox is addressed to a specific user (recipient_type=member,
 * recipient_id=user.sub) — items are filtered by recipient, NOT gated by a
 * workspace-membership check. The mark-read path additionally verifies the
 * loaded item is addressed to the requesting user (mirrors Go
 * loadInboxItemForUser).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import {
  countUnreadInbox,
  getInboxItemInWorkspace,
  getIssueStatus,
  listInboxItems,
  markInboxRead,
  type InboxItemRow,
} from "../../db/queries/inbox.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InboxItem = Omit<InboxItemRow, "issueStatus">;

/** Mirrors the Go InboxItemResponse struct (snake_case JSON). */
function inboxToResponse(i: InboxItem, issueStatus: string | null) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    recipient_type: i.recipientType,
    recipient_id: i.recipientId,
    type: i.type,
    severity: i.severity,
    issue_id: i.issueId,
    title: i.title,
    body: i.body,
    read: i.read,
    archived: i.archived,
    created_at: i.createdAt,
    issue_status: issueStatus,
    actor_type: i.actorType,
    actor_id: i.actorId,
    details: i.details ?? {},
  };
}

/**
 * Validate the X-Workspace-ID header. Returns the workspace UUID, or a Response
 * to short-circuit with (400 missing/malformed header). The inbox is filtered
 * by recipient, so there is no membership gate here (mirrors the Go handler,
 * which only parses the workspace id then filters by recipient_id).
 */
function requireWorkspace(c: Context<AppEnv>): string | Response {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  return wsId;
}

export function inboxRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = requireWorkspace(c);
    if (ws instanceof Response) return ws;
    const userId = c.get("user").sub;
    const rows = await listInboxItems(db, ws, "member", userId);
    return c.json(rows.map((row) => inboxToResponse(row, row.issueStatus)));
  });

  r.get("/unread-count", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = requireWorkspace(c);
    if (ws instanceof Response) return ws;
    const userId = c.get("user").sub;
    const count = await countUnreadInbox(db, ws, "member", userId);
    return c.json({ count });
  });

  r.post("/:id/read", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = requireWorkspace(c);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid inbox item id" }, 400);

    // Load + authorize: item must exist in the workspace AND be addressed to the
    // requesting user (mirrors Go loadInboxItemForUser).
    const prev = await getInboxItemInWorkspace(db, ws, id);
    const userId = c.get("user").sub;
    if (!prev || prev.recipientType !== "member" || prev.recipientId !== userId) {
      return c.json({ error: "inbox item not found" }, 404);
    }

    const item = await markInboxRead(db, prev.id);
    const issueStatus = item.issueId ? await getIssueStatus(db, item.issueId) : null;
    return c.json(inboxToResponse(item, issueStatus));
  });

  return r;
}
