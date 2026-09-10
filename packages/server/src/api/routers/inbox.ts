import type { Context, Hono } from "hono";
import {
  compatibilityInboxScope,
  denyCurrentUserWorkspaceAccess,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  inboxCompatibilityResponse,
  parseOptionalInt,
} from "../wire/index.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import type { RouterDeps } from "./deps.js";

export function registerInboxRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/inbox", (c) => {
    const scope = compatibilityInboxScope(c, store, c.req.query("memberId"));
    if (scope instanceof Response) return scope;
    const items = store.listInboxItems(scope.memberId, scope.workspaceId);
    return c.json({ items, total: items.length, unread: items.filter((item) => !item.read).length });
  });
  app.post("/api/multiremi/inbox/:id/read", (c) => {
    const item = loadInboxItemForCurrentUser(c, store);
    if (item instanceof Response) return item;
    return c.json({ item: store.markInboxItemRead(item.id) });
  });
  app.post("/api/multiremi/inbox/:id/archive", (c) => {
    const item = loadInboxItemForCurrentUser(c, store);
    if (item instanceof Response) return item;
    return c.json({ item: store.archiveInboxItem(item.id) });
  });
  app.get("/api/inbox", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json(store.listInboxItems(scope.memberId, scope.workspaceId).map(inboxCompatibilityResponse));
  });
  app.get("/api/inbox/page", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    const page = store.listInboxItemsPage(scope.memberId, {
      limit: parseOptionalInt(c.req.query("limit")),
      cursor: c.req.query("cursor") ?? null,
    }, scope.workspaceId);
    return c.json({
      items: page.items.map(inboxCompatibilityResponse),
      limit: page.limit,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    });
  });
  app.get("/api/inbox/summary", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    const rawOffset = parseOptionalInt(c.req.query("timezone_offset"));
    const timezoneOffset = Math.max(-840, Math.min(rawOffset ?? 0, 840));
    return c.json(store.getInboxSummary(scope.memberId, timezoneOffset, scope.workspaceId));
  });
  app.get("/api/inbox/unread-count", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json({ count: store.countUnreadInboxItems(scope.memberId, scope.workspaceId) });
  });
  app.post("/api/inbox/mark-all-read", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json({ count: store.markAllInboxItemsRead(scope.memberId, scope.workspaceId) });
  });
  app.post("/api/inbox/archive-all", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json({ count: store.archiveAllInboxItems(scope.memberId, "all", scope.workspaceId) });
  });
  app.post("/api/inbox/archive-all-read", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json({ count: store.archiveAllInboxItems(scope.memberId, "read", scope.workspaceId) });
  });
  app.post("/api/inbox/archive-completed", (c) => {
    const scope = compatibilityInboxScope(c, store);
    if (scope instanceof Response) return scope;
    return c.json({ count: store.archiveAllInboxItems(scope.memberId, "completed", scope.workspaceId) });
  });
  app.post("/api/inbox/:id/read", (c) => {
    const item = loadInboxItemForCurrentUser(c, store);
    if (item instanceof Response) return item;
    return c.json(inboxCompatibilityResponse(store.markInboxItemRead(item.id)));
  });
  app.post("/api/inbox/:id/archive", (c) => {
    const item = loadInboxItemForCurrentUser(c, store);
    if (item instanceof Response) return item;
    return c.json(inboxCompatibilityResponse(store.archiveInboxItem(item.id)));
  });
}

function loadInboxItemForCurrentUser(c: Context, store: RouterDeps["store"]) {
  const item = store.getInboxItem(c.req.param("id") ?? "");
  if (!item) return c.json({ error: "inbox item not found" }, 404);
  const explicitId = cleanString(c.req.query("workspaceId")) ?? cleanString(c.req.query("workspace_id"));
  const hasSelector = explicitId || cleanString(c.req.header("X-Workspace-ID")) || cleanString(c.req.header("X-Workspace-Slug"));
  const workspaceId = hasSelector ? resolveRequestWorkspaceId(c, store, explicitId) : item.workspaceId;
  if (workspaceId instanceof Response) return workspaceId;
  if (workspaceId !== item.workspaceId) return c.json({ error: "inbox item not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const userId = authenticatedRequestUserId(c);
  const member = item.memberId ? store.getWorkspaceMember(item.memberId) : null;
  if (!member || member.workspaceId !== workspaceId
    || (userId && member.userId !== userId && member.id !== userId)) {
    return c.json({ error: "inbox item not found" }, 404);
  }
  return item;
}
