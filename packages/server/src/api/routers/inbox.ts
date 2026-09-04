import type { Hono } from "hono";
import {
  compatibilityInboxMemberId,
} from "../helpers.js";
import {
  inboxCompatibilityResponse,
  parseOptionalInt,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerInboxRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/inbox", (c) => {
    const items = store.listInboxItems(c.req.query("memberId"));
    return c.json({ items, total: items.length, unread: items.filter((item) => !item.read).length });
  });
  app.post("/api/multiremi/inbox/:id/read", (c) => {
    return c.json({ item: store.markInboxItemRead(c.req.param("id")) });
  });
  app.post("/api/multiremi/inbox/:id/archive", (c) => {
    return c.json({ item: store.archiveInboxItem(c.req.param("id")) });
  });
  app.get("/api/inbox", (c) => c.json(store.listInboxItems(compatibilityInboxMemberId(c, store)).map(inboxCompatibilityResponse)));
  app.get("/api/inbox/page", (c) => {
    const page = store.listInboxItemsPage(compatibilityInboxMemberId(c, store), {
      limit: parseOptionalInt(c.req.query("limit")),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({
      items: page.items.map(inboxCompatibilityResponse),
      limit: page.limit,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    });
  });
  app.get("/api/inbox/summary", (c) => {
    const rawOffset = parseOptionalInt(c.req.query("timezone_offset"));
    const timezoneOffset = Math.max(-840, Math.min(rawOffset ?? 0, 840));
    return c.json(store.getInboxSummary(compatibilityInboxMemberId(c, store), timezoneOffset));
  });
  app.get("/api/inbox/unread-count", (c) => c.json({ count: store.countUnreadInboxItems(compatibilityInboxMemberId(c, store)) }));
  app.post("/api/inbox/mark-all-read", (c) => c.json({ count: store.markAllInboxItemsRead(compatibilityInboxMemberId(c, store)) }));
  app.post("/api/inbox/archive-all", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c, store), "all") }));
  app.post("/api/inbox/archive-all-read", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c, store), "read") }));
  app.post("/api/inbox/archive-completed", (c) => c.json({ count: store.archiveAllInboxItems(compatibilityInboxMemberId(c, store), "completed") }));
  app.post("/api/inbox/:id/read", (c) => c.json(inboxCompatibilityResponse(store.markInboxItemRead(c.req.param("id")))));
  app.post("/api/inbox/:id/archive", (c) => c.json(inboxCompatibilityResponse(store.archiveInboxItem(c.req.param("id")))));
}
