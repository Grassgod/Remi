import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { loadConfig, findConfigPath } from "../../src/config.js";
import { MenuSyncer } from "../../src/connectors/feishu/menu-sync.js";

export function registerBotMenuHandlers(app: Hono, data: RemiData) {
  // GET — read current bot_menu config from remi.toml
  app.get("/api/v1/bot-menu", (c) => {
    const config = data.readConfig();
    return c.json(config.bot_menu ?? { default: [], users: [] });
  });

  // PUT — update bot_menu config in remi.toml
  app.put("/api/v1/bot-menu", async (c) => {
    const body = await c.req.json();
    const ok = data.updateConfig({ bot_menu: body });
    if (!ok) return c.json({ error: "failed to update config" }, 500);
    return c.json({ ok: true });
  });

  // POST — sync current config to Feishu API
  // Reuses loadConfig() for parsing, same path as core.ts startup sync
  app.post("/api/v1/bot-menu/sync", async (c) => {
    const config = loadConfig(findConfigPath());

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
