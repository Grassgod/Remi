/**
 * Mission Board — Hono web server (port 8090).
 *
 * Two views:
 *   /board       — Personal board (auth required, switch projects)
 *   /board/:slug — Project board (public, single project)
 *
 * Runs in the same Remi daemon process, sharing DB + Feishu Client + BunQueue.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { MissionStore } from "../../src/mission/store.js";
import type { RemiConfig } from "../../src/config.js";
import type { ProjectConfig } from "../../src/mission/model.js";

export interface BoardDeps {
  config: RemiConfig;
  missionStore: MissionStore;
  authToken?: string;
  feishuClient?: any;  // Lark.Client instance for message fetching
}

/**
 * Resolve project config — supports both old string format and new object format.
 */
function resolveProjectConfig(projects: Record<string, unknown>): Map<string, ProjectConfig> {
  const result = new Map<string, ProjectConfig>();
  for (const [slug, value] of Object.entries(projects)) {
    if (typeof value === "string") {
      result.set(slug, { cwd: value });
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      result.set(slug, {
        cwd: (obj.cwd as string) ?? "",
        repoUrl: (obj.repo_url as string) ?? (obj.repoUrl as string) ?? undefined,
        repoType: (obj.repo_type as string) ?? (obj.repoType as string) ?? undefined,
        chatId: (obj.chat_id as string) ?? (obj.chatId as string) ?? undefined,
      } as ProjectConfig);
    }
  }
  return result;
}

export function createBoardApp(deps: BoardDeps): Hono {
  const app = new Hono();
  const { config, missionStore, authToken } = deps;

  // CORS for dev
  app.use("/api/*", cors());

  // ── Auth middleware for personal board ──
  app.use("/api/personal/*", async (c, next) => {
    if (!authToken) return next(); // no auth configured = open
    const header = c.req.header("Authorization");
    const token = header?.replace("Bearer ", "") ?? c.req.query("token");
    if (token !== authToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  // ── Projects API ──

  app.get("/api/projects", (c) => {
    const projectMap = resolveProjectConfig(config.projects as Record<string, unknown>);
    const projects = Array.from(projectMap.entries()).map(([slug, cfg]) => ({
      slug,
      name: slug,
      cwd: cfg.cwd,
      repoUrl: cfg.repoUrl ?? null,
      repoType: cfg.repoType ?? null,
      chatId: cfg.chatId ?? null,
    }));
    return c.json(projects);
  });

  app.get("/api/projects/:slug/missions", (c) => {
    const slug = c.req.param("slug");
    const missions = missionStore.listByProject(slug);
    return c.json(missions);
  });

  app.get("/api/projects/:slug/stats", (c) => {
    const slug = c.req.param("slug");
    const stats = missionStore.getProjectStats(slug);
    return c.json(stats);
  });

  // ── Missions API ──

  app.get("/api/missions/:id", (c) => {
    const mission = missionStore.getById(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    return c.json(mission);
  });

  app.post("/api/missions", async (c) => {
    const body = await c.req.json();
    if (!body.title || !body.projectId || !body.chatId) {
      return c.json({ error: "title, projectId, chatId required" }, 400);
    }
    const mission = missionStore.create(body);
    return c.json(mission, 201);
  });

  app.patch("/api/missions/:id", async (c) => {
    const id = c.req.param("id");
    const mission = missionStore.getById(id);
    if (!mission) return c.json({ error: "not found" }, 404);

    const body = await c.req.json();
    if (body.status) {
      missionStore.updateStatus(id, body.status);
    }
    if (body.title || body.description || body.currentStep) {
      missionStore.update(id, body);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/missions/:id", (c) => {
    const id = c.req.param("id");
    missionStore.delete(id);
    return c.json({ ok: true });
  });

  // ── Messages API — conversation reconstruction via shared parser ──

  app.get("/api/missions/:id/messages", async (c) => {
    const mission = missionStore.getById(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    if (!mission.chatId) return c.json([]);

    try {
      const { getDb } = await import("../../src/db/index.js");
      const { buildChatMessages } = await import("../../src/conversation/parser.js");
      const db = getDb();

      // Get session IDs for this mission's chat thread
      const queryParams = mission.threadId
        ? { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId, mission.threadId] }
        : { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId] };

      const sessionRows = db.query(queryParams.sql).all(...queryParams.params) as any[];
      const sessionIds = sessionRows.map((r: any) => r.cli_session_id as string);

      // Get metadata
      const metaSql = mission.threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";

      const metaRows = mission.threadId
        ? db.query(metaSql).all(mission.chatId, mission.threadId) as any[]
        : db.query(metaSql).all(mission.chatId) as any[];

      const messages = buildChatMessages(sessionIds, metaRows);
      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
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
        // Message-embedded image (user-sent screenshots etc.)
        ({ buffer } = await downloadMessageResourceFeishu(deps.feishuClient, msgId, imageKey, "image"));
      } else {
        // Standalone uploaded image (bot-created)
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

  // ── Chat name from Feishu API ──

  const chatNameCache = new Map<string, string>();

  app.get("/api/chat-name/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    if (chatNameCache.has(chatId)) return c.json({ name: chatNameCache.get(chatId) });
    if (!deps.feishuClient) return c.json({ name: "" }, 503);
    try {
      const resp = await deps.feishuClient.im.chat.get({ path: { chat_id: chatId } });
      const name = (resp as any)?.data?.name ?? "";
      if (name) chatNameCache.set(chatId, name);
      return c.json({ name });
    } catch {
      return c.json({ name: "" });
    }
  });

  // ── Health ──

  app.get("/api/health", (c) => c.json({ ok: true, service: "mission-board" }));

  // ── Static frontend (production) ──
  // Only serve static files if frontend/dist exists (Phase 1+)
  const staticDir = join(import.meta.dir, "frontend", "dist");
  try {
    const { existsSync } = require("node:fs");
    if (existsSync(staticDir)) {
      app.use("/*", serveStatic({ root: staticDir }));
      // SPA fallback — serve index.html for all non-API routes
      app.get("/*", async (c) => {
        const file = Bun.file(join(staticDir, "index.html"));
        return new Response(file);
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
    idleTimeout: 30, // seconds — Feishu API calls can take a few seconds
  });

  console.log(`[board] Mission Board listening on http://0.0.0.0:${port}`);
}
