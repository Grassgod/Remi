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
import { registerEvalHandlers } from "../handlers/eval.js";

export interface BoardDeps {
  config: any;
  missionStore?: any;        // Kept for backward compat, not used directly
  authToken?: string;
  feishuClient?: any;        // Lark.Client for image proxy
  enqueueMission?: (data: { missionId: string; step: string }) => Promise<void>;
  enqueueCron?: (data: { jobId: string; handler: string; handlerConfig?: Record<string, any> }) => Promise<void>;
}

export function createBoardApp(deps: BoardDeps): Hono {
  const app = new Hono();
  const data = new RemiData();

  // CORS for dev
  app.use("/api/*", cors());

  // ── Internal: cross-process mission enqueue (must register BEFORE shared handlers to avoid shadowing) ──
  app.post("/api/internal/enqueue-intake", async (c) => {
    const { missionId, step } = await c.req.json();
    if (!missionId || !step) return c.json({ error: "missionId and step required" }, 400);
    if (!deps.enqueueMission) return c.json({ error: "enqueue not available" }, 503);
    deps.enqueueMission({ missionId, step }).catch(() => {});
    return c.json({ ok: true, missionId, step });
  });

  // ── Internal: enqueue one-shot cron job (e.g. release-notes generation) ──
  app.post("/api/internal/enqueue-cron", async (c) => {
    const { jobId, handler, handlerConfig } = await c.req.json();
    if (!jobId || !handler) return c.json({ error: "jobId and handler required" }, 400);
    if (!deps.enqueueCron) return c.json({ error: "enqueue not available" }, 503);
    deps.enqueueCron({ jobId, handler, handlerConfig }).catch(() => {});
    return c.json({ ok: true, jobId, handler });
  });

  // ── Reuse Dashboard API handlers ──
  registerMissionsHandlers(app, data);
  registerConversationsHandlers(app, data);

  // ── Eval handlers ──
  const evalRoot = process.env.AIDEN_EVAL_ROOT || join(require("node:os").homedir(), "project", "aiden-server-plugin-lab", "aiden-eval");
  registerEvalHandlers(app, evalRoot);

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

  // (enqueue-intake endpoint registered above, before shared handlers)

  // ── Pages: serve static HTML from ~/tasks/:slug/ ──
  const tasksDir = join(require("node:os").homedir(), "tasks");
  try { require("node:fs").mkdirSync(tasksDir, { recursive: true }); } catch {}

  // List available pages
  app.get("/api/v1/pages", (c) => {
    const { existsSync, readdirSync, statSync } = require("node:fs");
    if (!existsSync(tasksDir)) return c.json([]);
    const entries = readdirSync(tasksDir)
      .filter((name: string) => {
        const p = join(tasksDir, name);
        return statSync(p).isDirectory() && existsSync(join(p, "index.html"));
      })
      .map((name: string) => {
        const stat = statSync(join(tasksDir, name, "index.html"));
        return { slug: name, updatedAt: stat.mtime.toISOString() };
      })
      .sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json(entries);
  });

  // Serve pages from ~/tasks/:slug/
  app.get("/p/:slug{.+}", async (c) => {
    const { existsSync } = require("node:fs");
    const fullPath = c.req.path;
    const match = fullPath.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (!match) return c.json({ error: "not found" }, 404);
    const slug = match[1];
    const rest = match[2]?.slice(1) || "index.html"; // strip leading /
    if (slug.includes("..") || rest.includes("..")) return c.json({ error: "forbidden" }, 403);
    const filePath = join(tasksDir, slug, rest);
    if (!existsSync(filePath)) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(filePath));
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
