import type { Hono } from "hono";
import { GroupConfigStore } from "../../src/group/store.js";

export function registerGroupHandlers(app: Hono) {
  const store = new GroupConfigStore();

  // List all group configs
  app.get("/api/v1/groups", (c) => {
    return c.json(store.list());
  });

  // Count groups per project (for Projects tab display)
  // NOTE: must be registered BEFORE /:chatId to avoid "count-by-project" being matched as a param
  app.get("/api/v1/groups/count-by-project", (c) => {
    return c.json(store.countByProject());
  });

  // Get single group config
  app.get("/api/v1/groups/:chatId", (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const config = store.getByChatId(chatId);
    if (!config) return c.json({ error: "not found" }, 404);
    return c.json(config);
  });

  // Create group config
  app.post("/api/v1/groups", async (c) => {
    const body = await c.req.json();
    if (!body.chatId) return c.json({ error: "chatId required" }, 400);
    store.upsert(body);
    return c.json({ ok: true });
  });

  // Update group config
  app.put("/api/v1/groups/:chatId", async (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const body = await c.req.json();
    const ok = store.update(chatId, body);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Delete group config
  app.delete("/api/v1/groups/:chatId", (c) => {
    const chatId = decodeURIComponent(c.req.param("chatId"));
    const ok = store.delete(chatId);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
