import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
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
  app.post("/api/v1/bot-menu/sync", async (c) => {
    const config = data.readConfig();
    const botMenu = config.bot_menu ?? {};
    const feishu = config.feishu ?? {};
    const triggerUserIds = (feishu.trigger_user_ids as string[]) ?? [];

    if (!feishu.app_id || !feishu.app_secret) {
      return c.json({ error: "feishu credentials not configured" }, 400);
    }

    const syncer = new MenuSyncer({
      appId: feishu.app_id as string,
      appSecret: feishu.app_secret as string,
    });

    // Parse config into the format MenuSyncer expects
    const menuConfig = {
      default: (botMenu.default as any[])?.map(parseMenuItem),
      users: (botMenu.users as any[])?.map((u: any) => ({
        userId: u.user_id,
        userIdType: u.user_id_type ?? "open_id",
        label: u.label,
        items: (u.items as any[])?.map(parseMenuItem) ?? [],
      })),
    };

    try {
      await syncer.syncAll(menuConfig, triggerUserIds);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}

// Convert TOML-style config to MenuSyncer format
function parseMenuItem(item: any): any {
  return {
    name: item.name ?? "",
    i18nName: item.i18n_name,
    icon: item.icon ? {
      token: item.icon.token,
      color: item.icon.color,
      fileKey: item.icon.file_key,
    } : undefined,
    tag: item.tag,
    behaviors: item.behaviors?.map((b: any) => ({
      type: b.type,
      url: b.url,
      eventKey: b.event_key,
      isPrimary: b.is_primary,
    })),
    children: item.children?.map(parseMenuItem),
  };
}
