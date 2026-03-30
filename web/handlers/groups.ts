import type { Hono } from "hono";
import { GroupConfigStore } from "../../src/group/store.js";
import { getChatName, transferChatOwner, updateChat } from "../../src/connectors/feishu/chat.js";
import { invalidateGroupNameCache } from "./conversations.js";
import { createLogger } from "../../src/logger.js";

const log = createLogger("groups");

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

  // Sync group names from Feishu API → group_configs.name
  app.post("/api/v1/groups/sync-names", async (c) => {
    const groups = store.list();
    let updated = 0;
    for (const g of groups) {
      if (g.name) continue; // already has a name
      const name = await getChatName(g.chatId);
      if (name) {
        store.update(g.chatId, { name });
        updated++;
        log.info(`synced group name: ${g.chatId} → ${name}`);
      }
    }
    invalidateGroupNameCache();
    return c.json({ ok: true, updated });
  });

  // Transfer ownership of all project groups to a user
  app.post("/api/v1/groups/transfer-ownership", async (c) => {
    const { ownerOpenId } = (await c.req.json()) as { ownerOpenId: string };
    if (!ownerOpenId) return c.json({ error: "ownerOpenId required" }, 400);

    const groups = store.list();
    let transferred = 0;
    let failed = 0;
    for (const g of groups) {
      const ok = await transferChatOwner(g.chatId, ownerOpenId);
      if (ok) transferred++;
      else failed++;
    }
    return c.json({ ok: true, transferred, failed });
  });

  // Update chat avatar for a group
  app.post("/api/v1/groups/update-chat", async (c) => {
    const { chatId, name, avatar, description } = (await c.req.json()) as {
      chatId: string;
      name?: string;
      avatar?: string;
      description?: string;
    };
    if (!chatId) return c.json({ error: "chatId required" }, 400);
    const ok = await updateChat(chatId, { name, avatar, description });
    if (!ok) return c.json({ error: "failed to update chat" }, 500);
    return c.json({ ok: true });
  });
}
