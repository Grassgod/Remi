/**
 * HTTP routes for /api/v1/cc-switch/* — drop-in for the old direct-SQLite
 * handlers. Same paths/shapes the frontend already calls (Mcp.tsx, Skills.tsx)
 * plus new routes for Prompts and Providers.
 */

import type { Hono } from "hono";
import type { ConfigHubService } from "./service.js";
import type { SkillsService } from "./skills-service.js";
import type { PromptsService } from "./prompts-service.js";
import type { ProvidersService } from "./providers-service.js";
import type { AppType } from "./types.js";
import { APP_TYPES } from "./types.js";

function appOk(v: string): v is AppType {
  return (APP_TYPES as readonly string[]).includes(v);
}

export function registerHttp(
  app: Hono,
  mcp: ConfigHubService,
  skills: SkillsService,
  prompts: PromptsService,
  providers: ProvidersService,
): void {
  // ── MCP: list ─────────────────────────────────────────────
  app.get("/api/v1/cc-switch/mcp", (c) => {
    try {
      const rows = mcp.listGlobalMcp();
      const servers = rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        command: r.config.command,
        args: r.config.args,
        env: r.config.env,
        transport: r.config.type ?? "stdio",
        apps: {
          claude: r.enabled.claude,
          codex: r.enabled.codex,
          gemini: r.enabled.gemini,
          opencode: false,
          hermes: false,
        },
      }));
      return c.json({ servers, available: true });
    } catch (e: any) {
      return c.json({ servers: [], available: true, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/v1/cc-switch/mcp", async (c) => {
    const body = (await c.req.json()) as any;
    if (!body.id || !body.name) return c.json({ error: "id, name required" }, 400);
    try {
      const report = mcp.upsertGlobalMcp({
        id: body.id,
        name: body.name,
        config: { command: body.command, args: body.args, env: body.env },
        description: body.description,
        enabled: body.apps ?? {},
      });
      return c.json({ ok: true, sync: report });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.put("/api/v1/cc-switch/mcp/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { app: appType, enabled } = (await c.req.json()) as { app: AppType; enabled: boolean };
    if (!appOk(appType)) return c.json({ error: `invalid app: ${appType}` }, 400);
    try {
      const report = mcp.toggleGlobalMcp(id, appType, enabled);
      return c.json({ ok: true, sync: report });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.delete("/api/v1/cc-switch/mcp/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    try {
      const report = mcp.deleteGlobalMcp(id);
      return c.json({ ok: true, sync: report });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.post("/api/v1/cc-switch/sync", (c) => {
    try {
      return c.json({ ok: true, sync: mcp.syncGlobal() });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  // ── Skills ────────────────────────────────────────────────
  app.get("/api/v1/cc-switch/skills", (c) => {
    try {
      const rows = skills.list();
      return c.json({
        available: true,
        skills: rows.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          directory: s.directory,
          apps: { claude: s.enabled.claude, codex: s.enabled.codex, gemini: s.enabled.gemini, opencode: false, hermes: false },
        })),
      });
    } catch (e: any) {
      return c.json({ skills: [], available: true, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/v1/cc-switch/skills", async (c) => {
    const body = (await c.req.json()) as { id?: string; name?: string; description?: string; sourceDir: string };
    if (!body.sourceDir) return c.json({ error: "sourceDir required" }, 400);
    try {
      const row = skills.installFromDir(body);
      return c.json({ ok: true, skill: row });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.put("/api/v1/cc-switch/skills/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { app: appType, enabled } = (await c.req.json()) as { app: AppType; enabled: boolean };
    if (!appOk(appType)) return c.json({ error: `invalid app: ${appType}` }, 400);
    try {
      return c.json({ ok: true, sync: skills.setEnabled(id, appType, enabled) });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.delete("/api/v1/cc-switch/skills/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    try {
      return c.json({ ok: true, sync: skills.uninstall(id) });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  // ── Prompts ───────────────────────────────────────────────
  app.get("/api/v1/cc-switch/prompts", (c) => {
    try {
      return c.json({ available: true, prompts: prompts.list() });
    } catch (e: any) {
      return c.json({ prompts: [], available: true, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/v1/cc-switch/prompts", async (c) => {
    const body = (await c.req.json()) as any;
    if (!body.id || !body.name || typeof body.content !== "string") {
      return c.json({ error: "id, name, content required" }, 400);
    }
    try {
      const report = prompts.upsertCanonical({
        id: body.id,
        name: body.name,
        content: body.content,
        description: body.description,
        enabled: body.enabled !== false,
      });
      return c.json({ ok: true, sync: report });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.put("/api/v1/cc-switch/prompts/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { enabled } = (await c.req.json()) as { enabled: boolean };
    try {
      return c.json({ ok: true, sync: prompts.setEnabled(id, enabled) });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.delete("/api/v1/cc-switch/prompts/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    try {
      return c.json({ ok: true, sync: prompts.delete(id) });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.post("/api/v1/cc-switch/prompts/sync", (c) => {
    try {
      return c.json({ ok: true, sync: prompts.syncAll() });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  // ── Providers ─────────────────────────────────────────────
  app.get("/api/v1/cc-switch/providers", (c) => {
    const appQ = c.req.query("app");
    const app: AppType | undefined = appQ && appOk(appQ) ? appQ : undefined;
    try {
      return c.json({ available: true, providers: providers.list(app) });
    } catch (e: any) {
      return c.json({ providers: [], available: true, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/v1/cc-switch/providers", async (c) => {
    const body = (await c.req.json()) as any;
    if (!body.id || !body.appType || !body.name) return c.json({ error: "id, appType, name required" }, 400);
    if (!appOk(body.appType)) return c.json({ error: `invalid appType: ${body.appType}` }, 400);
    try {
      providers.upsert({
        id: body.id,
        appType: body.appType,
        name: body.name,
        settingsConfig: body.settingsConfig ?? {},
        category: body.category,
      });
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.put("/api/v1/cc-switch/providers/:id/switch", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { app: appType } = (await c.req.json()) as { app: AppType };
    if (!appOk(appType)) return c.json({ error: `invalid app: ${appType}` }, 400);
    try {
      const applied = providers.switchTo(id, appType);
      return c.json({ ok: true, applied });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  app.delete("/api/v1/cc-switch/providers/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const appQ = c.req.query("app");
    if (!appQ || !appOk(appQ)) return c.json({ error: `app query param required` }, 400);
    try {
      providers.delete(id, appQ);
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 500);
    }
  });

  // ── Status ────────────────────────────────────────────────
  app.get("/api/v1/cc-switch/status", (c) => {
    try {
      return c.json({
        available: true,
        impl: "config-hub-native",
        mcpCount: mcp.listGlobalMcp().length,
        skillCount: skills.list().length,
        promptCount: prompts.list().length,
        providerCount: providers.list().length,
      });
    } catch (e: any) {
      return c.json({ available: true, error: e?.message ?? String(e) });
    }
  });
}
