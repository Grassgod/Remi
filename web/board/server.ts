/**
 * Mission Board — Standalone Hono web server (port 8090).
 *
 * Public, single-project mission board:
 *   /mission/:slug           — Project mission list (kanban/list)
 *   /mission/:slug/issue/:id — Mission detail + conversation
 *
 * Reuses Dashboard API handlers (missions + conversations).
 * Runs in the same Remi daemon process, sharing DB + Feishu Client.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { RemiData } from "../remi-data.js";
import { registerMissionsHandlers } from "../handlers/missions.js";
import { registerConversationsHandlers } from "../handlers/conversations.js";

export interface BoardDeps {
  config: any;
  missionStore?: any;        // Kept for backward compat, not used directly
  authToken?: string;
  feishuClient?: any;        // Lark.Client for image proxy
  enqueueMission?: (data: { missionId: string; step: string }) => Promise<void>;
}

export function createBoardApp(deps: BoardDeps): Hono {
  const app = new Hono();
  const data = new RemiData();

  // CORS for dev
  app.use("/api/*", cors());

  // ── Reuse Dashboard API handlers ──
  registerMissionsHandlers(app, data);
  registerConversationsHandlers(app, data);

  // ── Projects API (from DB, same format as Dashboard) ──
  app.get("/api/v1/projects", (c) => {
    try {
      const { ProjectStore } = require("../../src/project/store.js");
      const store = new ProjectStore();
      return c.json(store.list());
    } catch {
      return c.json([]);
    }
  });

  // ── Image proxy with disk cache ──

  const imageCacheDir = join(require("node:os").homedir(), ".remi", "lark_image");
  try { require("node:fs").mkdirSync(imageCacheDir, { recursive: true }); } catch {}

  app.get("/api/image/:imageKey", async (c) => {
    const imageKey = c.req.param("imageKey");
    if (!imageKey?.startsWith("img_")) return c.json({ error: "invalid key" }, 400);

    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const cachePath = join(imageCacheDir, imageKey);

    // Serve from disk cache
    if (existsSync(cachePath)) {
      const buf = readFileSync(cachePath);
      return new Response(buf, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Download from Feishu and cache
    if (!deps.feishuClient) return c.json({ error: "no feishu client" }, 503);
    try {
      const { downloadImageFeishu, downloadMessageResourceFeishu } = await import("../../src/connectors/feishu/media.js");
      let buffer: Buffer;
      const msgId = c.req.query("msgId");
      if (msgId) {
        ({ buffer } = await downloadMessageResourceFeishu(deps.feishuClient, msgId, imageKey, "image"));
      } else {
        ({ buffer } = await downloadImageFeishu(deps.feishuClient, imageKey));
      }
      writeFileSync(cachePath, buffer);
      return new Response(buffer, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // ── Internal: cross-process mission enqueue (called by remi-web) ──
  app.post("/api/internal/enqueue-intake", async (c) => {
    const { missionId, step } = await c.req.json();
    if (!missionId || !step) return c.json({ error: "missionId and step required" }, 400);
    if (!deps.enqueueMission) return c.json({ error: "enqueue not available" }, 503);
    await deps.enqueueMission({ missionId, step });
    return c.json({ ok: true, missionId, step });
  });

  // ── Health ──
  app.get("/api/health", (c) => c.json({ ok: true, service: "mission-board" }));

  // ── Static frontend — serve board SPA from dashboard build ──
  const staticDir = join(import.meta.dir, "..", "frontend", "dist");
  try {
    const { existsSync } = require("node:fs");
    if (existsSync(staticDir)) {
      // Only serve /assets/* as static files (prevent index.html leak)
      app.use("/assets/*", serveStatic({ root: staticDir }));
      // All non-API routes → board.html (SPA fallback)
      app.get("/*", async (c) => {
        return new Response(Bun.file(join(staticDir, "board.html")));
      });
    }
  } catch {
    // No frontend built yet — API-only mode
  }

  return app;
}

/**
 * Start the Board server on port 8090.
 */
export function startBoardServer(deps: BoardDeps): void {
  const app = createBoardApp(deps);
  const port = parseInt(process.env.REMI_BOARD_PORT ?? "8090", 10);

  Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 30,
  });

  console.log(`[board] Mission Board listening on http://0.0.0.0:${port}`);
}
