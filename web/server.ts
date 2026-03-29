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

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "./auth.js";
import { RemiData } from "./remi-data.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerAuthHandlers } from "./handlers/auth.js";
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
// Dynamic import — mission module may not exist in worktree
let registerMissionsHandlers: ((app: any, data: any) => void) | null = null;
try { ({ registerMissionsHandlers } = require("./handlers/missions.js")); } catch {}
import { registerWikiHandlers } from "./handlers/wiki.js";
import { registerSkillsHandlers } from "./handlers/skills.js";
import { registerAgentsHandlers } from "./handlers/agents.js";
import { registerMcpHandlers } from "./handlers/mcp.js";
import { registerProjectInitHandlers } from "./handlers/project-init.js";
import { registerGroupHandlers } from "./handlers/groups.js";
import { ProjectStore } from "../src/project/store.js";

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

  // Global middleware
  if (devMode) {
    app.use("/api/*", cors());
  }
  app.use("/api/*", authMiddleware(authToken));

  // Global error handler
  app.onError((err, c) => {
    console.error("[API Error]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // Register all handler modules
  registerStatusHandlers(app, data);
  registerMemoryHandlers(app, data);
  registerAuthHandlers(app, data);
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
  registerMissionsHandlers?.(app, data);
  registerWikiHandlers(app, data);
  registerSkillsHandlers(app, data);
  registerAgentsHandlers(app, data);
  registerMcpHandlers(app, data);
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
      if (!resp.ok) return c.json({ error: "image not found" }, resp.status);
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

  // Static files (production only)
  if (!devMode) {
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("/*", serveStatic({ path: join(staticDir, "index.html") }));
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

// ── Auto-start (standalone service) ───────────────────

const devMode = process.argv.includes("--dev");
const { port } = startWebDashboard({ devMode });

console.log(`[remi-web] Dashboard started on port ${port} (${devMode ? "dev" : "production"})`);
