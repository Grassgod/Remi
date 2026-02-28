#!/usr/bin/env bun
/**
 * Remi Web Dashboard — Independent API + static file server
 *
 * Can run standalone:
 *   bun run web/server.ts              # Production (serves API + built frontend)
 *   bun run web/server.ts --dev        # Dev mode (API only, frontend via Vite)
 *
 * Or imported by daemon:
 *   import { startWebDashboard, stopWebDashboard } from "./web/server.js";
 */

import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import { Router } from "./router.js";
import { RemiData } from "./remi-data.js";
import { checkAuth, unauthorizedResponse } from "./auth.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerSessionHandlers } from "./handlers/sessions.js";
import { registerAuthHandlers } from "./handlers/auth.js";
import { registerConfigHandlers } from "./handlers/config.js";

// ── MIME types ─────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ── Exported start/stop ────────────────────────────────

let _server: ReturnType<typeof Bun.serve> | null = null;

export interface WebDashboardOptions {
  port?: number;
  authToken?: string;
  devMode?: boolean;
}

export function startWebDashboard(opts: WebDashboardOptions = {}): { port: number } {
  const port = opts.port ?? parseInt(process.env.REMI_WEB_PORT ?? "6120", 10);
  const authToken = opts.authToken ?? process.env.REMI_WEB_AUTH_TOKEN ?? "";
  const devMode = opts.devMode ?? false;
  const staticDir = join(import.meta.dir, "frontend", "dist");

  const data = new RemiData();
  const router = new Router();

  registerStatusHandlers(router, data);
  registerMemoryHandlers(router, data);
  registerSessionHandlers(router, data);
  registerAuthHandlers(router, data);
  registerConfigHandlers(router, data);

  _server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS for dev mode
      if (devMode && req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        if (!checkAuth(req, authToken)) {
          return unauthorizedResponse();
        }

        const match = router.match(req);
        if (match) {
          try {
            const response = await match.handler(req, match.params);
            if (devMode) {
              const headers = new Headers(response.headers);
              headers.set("Access-Control-Allow-Origin", "*");
              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
            }
            return response;
          } catch (err) {
            console.error("[API Error]", err);
            return Response.json({ error: "Internal server error" }, { status: 500 });
          }
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      }

      // Static files (production only)
      if (!devMode && existsSync(staticDir)) {
        let filePath = join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);

        const file = Bun.file(filePath);
        if (await file.exists()) {
          const ext = extname(filePath);
          return new Response(file, {
            headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
          });
        }

        // SPA fallback
        const indexFile = Bun.file(join(staticDir, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { "Content-Type": "text/html" },
          });
        }
      }

      if (devMode) {
        return Response.json({
          message: "Remi Web API (dev mode). Frontend at http://localhost:5173",
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return { port };
}

export function stopWebDashboard(): void {
  if (_server) {
    _server.stop(true);
    _server = null;
  }
}

// ── Standalone entry point ─────────────────────────────

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isMain) {
  const devMode = process.argv.includes("--dev");
  const { port } = startWebDashboard({ devMode });

  console.log(`
╔══════════════════════════════════════════╗
║  REMI WEB DASHBOARD                     ║
║  http://localhost:${port}                  ║
║  Mode: ${devMode ? "development" : "production "}                     ║
╚══════════════════════════════════════════╝
`);
}
