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
import { readdirSync, statSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "./auth.js";
import { RemiData } from "./remi-data.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerSessionHandlers } from "./handlers/sessions.js";
import { registerAuthHandlers } from "./handlers/auth.js";
import { registerConfigHandlers } from "./handlers/config.js";
import { registerProjectHandlers } from "./handlers/projects.js";
import { registerAnalyticsHandlers } from "./handlers/analytics.js";
import { registerTracesHandlers } from "./handlers/traces.js";
import { registerLogsHandlers } from "./handlers/logs.js";
import { registerMonitorHandlers } from "./handlers/monitor.js";
import { registerSchedulerHandlers } from "./handlers/scheduler.js";
import { registerDbHandlers } from "./handlers/db.js";

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
  registerSessionHandlers(app, data);
  registerAuthHandlers(app, data);
  registerConfigHandlers(app, data);
  registerProjectHandlers(app, data);
  registerAnalyticsHandlers(app, data);
  registerTracesHandlers(app, data);
  registerLogsHandlers(app, data);
  registerMonitorHandlers(app, data);
  registerSchedulerHandlers(app, data);
  registerDbHandlers(app, data);

  // Auto-mount all task directories as /tasks/<dir-name>/*
  const tasksDir = "/data00/home/hehuajie/tasks";
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
