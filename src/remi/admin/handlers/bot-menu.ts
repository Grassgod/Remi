import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ConfigStore } from "@shared/db/config-store.js";
import { getDb } from "@shared/db/index.js";
import { MenuSyncer } from "../../../connectors/feishu/sdk.js";

export function registerBotMenuHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/bot-menu", (c) => {
    const store = new ConfigStore(getDb());
    const botMenu = store.getSection("botMenu") ?? { default: [], users: [] };
    return c.json(botMenu);
  });

  app.put("/api/v1/bot-menu", async (c) => {
    const body = await c.req.json();
    const store = new ConfigStore(getDb());
    store.setSection("botMenu", body);
    return c.json({ ok: true });
  });

  app.post("/api/v1/bot-menu/sync", async (c) => {
    const store = new ConfigStore(getDb());
    const config = store.load();

    if (!config.feishu.appId || !config.feishu.appSecret) {
      return c.json({ error: "feishu credentials not configured" }, 400);
    }

    const syncer = new MenuSyncer({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });

    try {
      await syncer.syncAll(config.botMenu, config.feishu.triggerUserIds);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
