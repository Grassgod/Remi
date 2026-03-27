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
import { getSessionName } from "../../src/connectors/feishu/session-name.js";

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

  // ── Messages API — pure JSONL-based conversation reconstruction ──

  app.get("/api/missions/:id/messages", async (c) => {
    const mission = missionStore.getById(c.req.param("id"));
    if (!mission) return c.json({ error: "not found" }, 404);
    if (!mission.chatId) return c.json([]);

    try {
      const { getDb } = await import("../../src/db/index.js");
      const { readFileSync, readdirSync, existsSync: fsExists } = await import("node:fs");
      const { join: pathJoin } = await import("node:path");
      const { homedir: getHome } = await import("node:os");

      const db = getDb();
      const claudeProjectsDir = pathJoin(getHome(), ".claude", "projects");

      // ── Step 1: Get all session IDs for this thread from conversations table ──
      const queryParams = mission.threadId
        ? { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId, mission.threadId] }
        : { sql: "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC", params: [mission.chatId] };

      const sessionRows = db.query(queryParams.sql).all(...queryParams.params) as any[];
      const sessionIds = sessionRows.map((r: any) => r.cli_session_id as string);

      // Also get conversation metadata keyed by created_at order
      const metaSql = mission.threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";
      const metaRows = (mission.threadId
        ? db.query(metaSql).all(mission.chatId, mission.threadId)
        : db.query(metaSql).all(mission.chatId)) as any[];

      // ── Step 2: Read JSONL files, extract enqueue→assistant pairs ──
      // Each step in the process panel — interleaved thinking + tool_use (like Feishu card)
      interface StepItem {
        type: "thinking" | "tool";
        content: string;        // thinking text or tool description
        name?: string;          // tool name (if type=tool)
        thinking?: string;      // merged thinking before tool (if type=tool)
      }

      interface ConvPair {
        userText: string;       // cleaned user message
        remiText: string;       // assistant response
        steps: StepItem[];      // interleaved thinking + tool_use (Feishu card order)
        timestamp: number;      // from enqueue entry
        sessionId: string;
      }

      function stripContextTags(text: string): string {
        let t = text;
        // Remove XML context/system blocks
        t = t.replace(/<context>[\s\S]*?<\/context>/g, "");
        t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
        t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
        // Remove [Replying to: "..."] — find the pattern start and cut until closing "]"
        const replyIdx = t.indexOf('[Replying to: "');
        if (replyIdx !== -1) {
          // Find the closing "]\n or "] at end
          const closeIdx = t.indexOf('"]', replyIdx + 15);
          if (closeIdx !== -1) {
            t = t.slice(0, replyIdx) + t.slice(closeIdx + 2);
          }
        }
        t = t.replace(/^贺华杰:\s*/m, "");
        return t.trim();
      }

      const allPairs: ConvPair[] = [];

      for (const sessionId of sessionIds) {
        // Find JSONL file
        let jsonlPath: string | null = null;
        try {
          for (const dir of readdirSync(claudeProjectsDir)) {
            const p = pathJoin(claudeProjectsDir, dir, sessionId + ".jsonl");
            if (fsExists(p)) { jsonlPath = p; break; }
          }
        } catch {}
        if (!jsonlPath) continue;

        const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");

        // Parse: enqueue → collect assistant blocks until next enqueue
        let currentEnqueue: { content: string; timestamp: number /* unix ms */ } | null = null;
        let currentText = "";
        let currentSteps: StepItem[] = [];

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);

            // User message = queue-operation enqueue
            if (obj.type === "queue-operation" && obj.operation === "enqueue" && obj.content) {
              // Flush previous pair
              if (currentEnqueue && (currentText || currentSteps.length > 0)) {
                allPairs.push({
                  userText: stripContextTags(currentEnqueue.content),
                  remiText: stripContextTags(currentText),
                  steps: currentSteps,
                  timestamp: currentEnqueue.timestamp,
                  sessionId,
                });
              }
              // Convert ISO timestamp to Unix ms for sorting/display
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
              currentEnqueue = { content: obj.content, timestamp: ts };
              currentText = "";
              currentSteps = [];
            }

            // Remi response = assistant entries — interleave thinking + tool_use
            if (obj.type === "assistant" && currentEnqueue) {
              for (const b of (obj.message?.content ?? [])) {
                if (b.type === "text" && b.text) {
                  // Concatenate all text blocks (Claude emits multiple text blocks between tool calls)
                  currentText += (currentText ? "\n\n" : "") + b.text;
                } else if (b.type === "thinking" && b.thinking) {
                  currentSteps.push({ type: "thinking", content: b.thinking.trim() });
                } else if (b.type === "tool_use") {
                  // Merge preceding thinking into tool step (matches Feishu card behavior)
                  const lastStep = currentSteps[currentSteps.length - 1];
                  if (lastStep?.type === "thinking") {
                    // Replace standalone thinking with merged tool step
                    currentSteps[currentSteps.length - 1] = {
                      type: "tool",
                      name: b.name ?? "unknown",
                      content: b.input?.description ?? b.input?.command?.slice(0, 80) ?? b.input?.file_path ?? "",
                      thinking: lastStep.content,
                    };
                  } else {
                    currentSteps.push({
                      type: "tool",
                      name: b.name ?? "unknown",
                      content: b.input?.description ?? b.input?.command?.slice(0, 80) ?? b.input?.file_path ?? "",
                    });
                  }
                }
              }
            }
          } catch {}
        }
        // Flush last pair
        if (currentEnqueue && (currentText || currentSteps.length > 0)) {
          allPairs.push({
            userText: stripContextTags(currentEnqueue.content),
            remiText: stripContextTags(currentText),
            steps: currentSteps,
            timestamp: currentEnqueue.timestamp,
            sessionId,
          });
        }
      }

      // Sort by timestamp
      allPairs.sort((a, b) => a.timestamp - b.timestamp);

      // ── Step 3: Filter to complete pairs (user text + remi text) ──
      // Only emit pairs where Remi produced a final text response
      // (tools-only rounds are intermediate steps, not complete responses)
      const completePairs = allPairs.filter(p => p.remiText);

      const messages: any[] = [];

      // Build metadata lookup by timestamp for closest-match
      const metaByTime = metaRows.map((m: any) => ({
        ...m,
        _ts: new Date(m.created_at + "Z").getTime(), // DB stores UTC without Z
      }));

      function findClosestMeta(pairTs: number): any {
        let best: any = null;
        let bestDist = Infinity;
        for (const m of metaByTime) {
          const dist = Math.abs(m._ts - pairTs);
          if (dist < bestDist) { bestDist = dist; best = m; }
        }
        // Only match if within 30 seconds
        return best && bestDist < 30_000 ? best : null;
      }

      for (let i = 0; i < completePairs.length; i++) {
        const pair = completePairs[i];
        const meta = findClosestMeta(pair.timestamp);
        const createTimeMs = String(pair.timestamp);

        // User message
        if (pair.userText) {
          messages.push({
            id: `user_${i}`,
            type: "text",
            content: pair.userText,
            senderType: "user",
            senderId: meta?.sender_id ?? "",
            createTime: createTimeMs,
          });
        }

        // Remi response
        const toolSteps = pair.steps.filter(s => s.type === "tool");
        let toolCount = toolSteps.length;
        if (meta?.spans) {
          try {
            const spans = JSON.parse(meta.spans);
            const ps = spans.find((s: any) => s.op === "provider.chat");
            if (ps?.tool_count > toolCount) toolCount = ps.tool_count;
          } catch {}
        }

        messages.push({
          id: `remi_${i}`,
          type: "assistant",
          content: pair.remiText,
          senderType: "app",
          senderId: "remi",
          createTime: String(pair.timestamp + 1), // +1ms to keep user→remi order within pair
          steps: pair.steps.length > 0 ? pair.steps : undefined,
          sessionName: getSessionName(pair.sessionId),
          meta: meta ? {
            model: meta.model,
            inputTokens: meta.input_tokens,
            outputTokens: meta.output_tokens,
            cost: meta.cost_usd,
            duration: meta.duration_ms,
            toolCount,
            sessionId: pair.sessionId,
          } : undefined,
        });
      }

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
      const { downloadImageFeishu } = await import("../../src/connectors/feishu/media.js");
      const { buffer } = await downloadImageFeishu(deps.feishuClient, imageKey);
      writeFileSync(cachePath, buffer);
      return new Response(buffer, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
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
