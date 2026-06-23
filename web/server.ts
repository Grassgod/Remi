#!/usr/bin/env bun
/**
 * Remi Web Dashboard — Hono-based API + static file server
 *
 * Can run standalone:
 *   bun run web/server.ts              # Production (serves API + built frontend)
 *   bun run web/server.ts --dev        # Dev mode (API only, frontend via Vite)
 *
 * Or imported by daemon:
 *   import { startWebDashboard, stopWebDashboard } from "./web/server.js";
 */

import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "./auth.js";
import { RemiData } from "./remi-data.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerAuthHandlers } from "./handlers/auth.js";
import { SsoPlugin } from "../src/plugins/sso/index.js";
import { getDb } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { registerConfigHandlers } from "./handlers/config.js";
import { registerProjectHandlers } from "./handlers/projects.js";
import { registerAnalyticsHandlers } from "./handlers/analytics.js";
import { registerTracesHandlers } from "./handlers/traces.js";
import { registerLogsHandlers } from "./handlers/logs.js";
import { registerMonitorHandlers } from "./handlers/monitor.js";
import { registerSchedulerHandlers } from "./handlers/scheduler.js";
import { registerDbHandlers } from "./handlers/db.js";
import { registerBotMenuHandlers } from "./handlers/bot-menu.js";
import { registerSymlinkHandlers } from "./handlers/symlinks.js";
import { registerConversationsHandlers } from "./handlers/conversations.js";
import { registerWikiHandlers } from "./handlers/wiki.js";
import { registerSkillsHandlers } from "./handlers/skills.js";
import { registerAgentsHandlers } from "./handlers/agents.js";
import { registerMcpHandlers } from "./handlers/mcp.js";
import { ConfigHubPlugin, setConfigHubInstance } from "../src/plugins/config-hub/index.js";
import { registerProjectInitHandlers } from "./handlers/project-init.js";
import { registerGroupHandlers } from "./handlers/groups.js";
import { ProjectStore } from "../src/project/store.js";
import { PluginRegistry } from "../src/plugins/registry.js";

// ── Exported start/stop ────────────────────────────────

let _server: ReturnType<typeof Bun.serve> | null = null;

export interface WebDashboardOptions {
  port?: number;
  authToken?: string;
  devMode?: boolean;
}

export function createApp(opts: { authToken?: string; devMode?: boolean } = {}): Hono {
  const authToken = opts.authToken ?? "";
  const devMode = opts.devMode ?? false;
  const staticDir = join(import.meta.dir, "frontend", "dist");

  const data = new RemiData();
  const app = new Hono();

  // ── SSO plugin: install DB tables, seed from toml, register routes ──
  const remiConfig = loadConfig();
  const sso = new SsoPlugin({ adminEmails: remiConfig.auth.adminEmails });
  sso.migrate(getDb());
  sso.seed();

  // ── config-hub plugin: cross-tool MCP/Skills/Prompts management ──
  const hub = new ConfigHubPlugin();
  hub.migrate(getDb());
  setConfigHubInstance(hub);

  // Global middleware
  if (devMode) {
    app.use("/api/*", cors());
  }
  // SSO middleware first (gates non-public paths if SSO active);
  // then legacy bearer-token middleware (still supported for /api/* if used).
  app.use("/api/*", sso.middleware());
  app.use("/api/*", authMiddleware(authToken));

  // Global error handler
  app.onError((err, c) => {
    console.error("[API Error]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // ── Plugins (web surface): DB migrate/seed, middleware, and routes ──
  // Built-in SSO/config-hub stay wired explicitly above (middleware ordering).
  // Plugin middleware mounts here (before route handlers) so it applies to them.
  new PluginRegistry().load(remiConfig).dispatchWeb(app, { db: getDb(), config: remiConfig });

  // Register all handler modules
  registerStatusHandlers(app, data);
  registerMemoryHandlers(app, data);
  registerAuthHandlers(app, data);
  sso.registerHttp(app);
  registerConfigHandlers(app, data);
  registerProjectHandlers(app, data);
  registerGroupHandlers(app);
  registerAnalyticsHandlers(app, data);
  registerTracesHandlers(app, data);
  registerLogsHandlers(app, data);
  registerMonitorHandlers(app, data);
  registerSchedulerHandlers(app, data);
  registerDbHandlers(app, data);
  registerBotMenuHandlers(app, data);
  registerSymlinkHandlers(app, data);
  registerConversationsHandlers(app, data);
  registerWikiHandlers(app, data);
  registerSkillsHandlers(app, data);
  registerAgentsHandlers(app, data);
  registerMcpHandlers(app, data);
  hub.registerHttp(app);
  registerProjectInitHandlers(app);

  // ── Filesystem browse (for directory picker) ──
  app.get("/api/v1/fs/browse", (c) => {
    const { readdirSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    const target = c.req.query("path") || join(homedir(), "project");
    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e: any) => e.isDirectory() && !e.name.startsWith("."))
        .map((e: any) => ({ name: e.name, path: join(target, e.name) }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      return c.json({ path: target, dirs });
    } catch {
      return c.json({ error: "Cannot read directory" }, 400);
    }
  });

  // ── Image proxy (shared cache with Board server) ──
  const imageCacheDir = join(require("node:os").homedir(), ".remi", "lark_image");
  try { require("node:fs").mkdirSync(imageCacheDir, { recursive: true }); } catch {}

  app.get("/api/image/:imageKey", async (c) => {
    const imageKey = c.req.param("imageKey");
    if (!imageKey?.startsWith("img_")) return c.json({ error: "invalid key" }, 400);

    const { existsSync, readFileSync } = require("node:fs");
    const cachePath = join(imageCacheDir, imageKey);

    // Serve from shared disk cache
    if (existsSync(cachePath)) {
      const buf = readFileSync(cachePath);
      return new Response(buf, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Proxy to Board server (which has feishuClient for downloads)
    try {
      const boardPort = process.env.REMI_BOARD_PORT ?? "8090";
      const msgId = c.req.query("msgId") ?? "";
      const qs = msgId ? `?msgId=${encodeURIComponent(msgId)}` : "";
      const resp = await fetch(`http://127.0.0.1:${boardPort}/api/image/${imageKey}${qs}`);
      if (!resp.ok) return c.json({ error: "image not found" }, { status: resp.status as any });
      const buf = Buffer.from(await resp.arrayBuffer());
      // Cache locally for next time
      try { require("node:fs").writeFileSync(cachePath, buf); } catch {}
      return new Response(buf, {
        headers: { "Content-Type": resp.headers.get("Content-Type") ?? "image/png", "Cache-Control": "public, max-age=86400" },
      });
    } catch {
      return c.json({ error: "image proxy failed" }, 502);
    }
  });

  // Auto-mount all task directories as /tasks/<dir-name>/*
  const tasksDir = join(homedir(), "tasks");
  try {
    for (const entry of readdirSync(tasksDir)) {
      const fullPath = join(tasksDir, entry);
      if (statSync(fullPath).isDirectory()) {
        app.use(`/tasks/${entry}/*`, serveStatic({ root: fullPath, rewriteRequestPath: (p) => p.replace(`/tasks/${entry}`, "") }));
      }
    }
  } catch { /* tasks dir missing — skip */ }

  // ── Pages: list ~/tasks/<slug>/ that contain index.html ──
  app.get("/api/v1/pages", (c) => {
    try {
      if (!existsSync(tasksDir)) return c.json([]);
      const entries = readdirSync(tasksDir)
        .filter((name) => {
          const p = join(tasksDir, name);
          return statSync(p).isDirectory() && existsSync(join(p, "index.html"));
        })
        .map((name) => ({
          slug: name,
          updatedAt: statSync(join(tasksDir, name, "index.html")).mtime.toISOString(),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });

  // ── /p/:slug — serve static page content from ~/tasks/:slug/ ──
  //
  // Security: resolves the requested path and ensures it stays inside
  // `tasksDir`. This catches URL-encoded `..%2f`, absolute paths, symlinks
  // pointing outside, etc. — defenses the naive `.includes("..")` misses.
  const tasksDirResolved = resolvePath(tasksDir) + pathSep;
  app.get("/p/:slug{.+}", async (c) => {
    const fullPath = c.req.path;
    const match = fullPath.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (!match) return c.json({ error: "not found" }, 404);
    const slug = decodeURIComponent(match[1]);
    let rest = match[2] ? decodeURIComponent(match[2].slice(1)) : "";
    // Default index for directory-style URLs (/p/foo, /p/foo/, /p/foo/sub/).
    if (!rest || rest.endsWith("/")) rest = `${rest}index.html`;

    const requested = resolvePath(tasksDir, slug, rest);
    if (
      !requested.startsWith(tasksDirResolved) &&
      requested !== tasksDirResolved.slice(0, -1)
    ) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!existsSync(requested) || !statSync(requested).isFile()) {
      return c.json({ error: "not found" }, 404);
    }
    return new Response(Bun.file(requested));
  });

  // ── Static files (production only) ──
  // Only serve actual files from /assets and /fonts; everything else
  // falls through to the SPA fallback below, which serves the dashboard.
  if (!devMode) {
    app.use("/assets/*", serveStatic({ root: staticDir }));
    app.use("/fonts/*",  serveStatic({ root: staticDir }));
    app.get("/*", () => {
      return new Response(Bun.file(join(staticDir, "index.html")));
    });
  }

  // Dev mode fallback
  if (devMode) {
    app.all("/*", (c) => {
      return c.json({
        message: "Remi Web API (dev mode). Frontend at http://localhost:5173",
      });
    });
  }

  return app;
}

export function startWebDashboard(opts: WebDashboardOptions = {}): { port: number } {
  const port = opts.port ?? parseInt(process.env.REMI_WEB_PORT ?? "6120", 10);
  const authToken = opts.authToken ?? process.env.REMI_WEB_AUTH_TOKEN ?? "";
  const devMode = opts.devMode ?? false;

  const app = createApp({ authToken, devMode });

  _server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  return { port };
}

export function stopWebDashboard(): void {
  if (_server) {
    _server.stop(true);
    _server = null;
  }
}

// ── Auto-start ONLY when invoked directly (not when imported) ──
// When src/cli/serve.ts imports startWebDashboard, this block doesn't fire.

if (import.meta.main) {
  const devMode = process.argv.includes("--dev");
  const { port } = startWebDashboard({ devMode });
  console.log(`[remi-web] Dashboard started on port ${port} (${devMode ? "dev" : "production"})`);
}
