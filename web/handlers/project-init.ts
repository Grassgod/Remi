/**
 * Project Init API handlers — init, status, retry, SSE stream.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RemiData } from "../remi-data.js";
import { ProjectStore } from "../../src/project/store.js";
import type { ProjectInitInput } from "../../src/project/model.js";
import { runProjectInit, retryProjectInit, subscribe } from "../../src/project/init.js";

export function registerProjectInitHandlers(app: Hono, data: RemiData) {
  const store = new ProjectStore();

  // ── Start init ──
  app.post("/api/v1/projects/init", async (c) => {
    const input = (await c.req.json()) as ProjectInitInput;

    if (!input.alias?.trim() || !input.name?.trim()) {
      return c.json({ error: "alias and name are required" }, 400);
    }
    if (!input.dirMode || !["clone", "existing"].includes(input.dirMode)) {
      return c.json({ error: "dirMode must be 'clone' or 'existing'" }, 400);
    }
    if (input.dirMode === "clone" && !input.repoUrl?.trim()) {
      return c.json({ error: "repoUrl required for clone mode" }, 400);
    }
    if (input.dirMode === "existing" && !input.existingPath?.trim()) {
      return c.json({ error: "existingPath required for existing mode" }, 400);
    }

    // Check duplicate — preserve chatId from previous attempt for reuse
    const existing = store.getById(input.alias);
    if (existing && existing.initStatus === "completed") {
      return c.json({ error: `Project "${input.alias}" already exists` }, 409);
    }

    // Look for chatId: current record → kv (from deleted project)
    const { kvGet, kvDelete } = require("../../src/db/index.js");
    const previousChatId = existing?.chatId
      ?? kvGet(`deleted_project_chat:${input.alias}`)
      ?? null;

    // If there's a previous attempt, delete it first
    if (existing) {
      store.delete(input.alias);
    }

    const project = store.create(input);

    // Restore previous chatId so step 1 skips group creation
    if (previousChatId) {
      store.updateField(input.alias, "chat_id", previousChatId);
      kvDelete(`deleted_project_chat:${input.alias}`);
    }

    // Run async — don't await
    runProjectInit(store, input, data).catch((err) => {
      console.error(`[project-init] Fatal error for ${input.alias}:`, err);
    });

    return c.json({ id: project.id, status: "running" });
  });

  // ── Get init status ──
  app.get("/api/v1/projects/init/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  // ── Retry from failed step ──
  app.post("/api/v1/projects/init/:id/retry", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));

    try {
      // Run async — don't await
      retryProjectInit(store, id, data).catch((err) => {
        console.error(`[project-init] Retry error for ${id}:`, err);
      });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ── SSE stream ──
  app.get("/api/v1/projects/init/:id/stream", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const project = store.getById(id);
    if (!project) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      // Send current state first
      await stream.writeSSE({
        event: "state",
        data: JSON.stringify(project.initSteps),
      });

      // If already done/failed, close immediately
      if (project.initStatus === "completed" || project.initStatus === "failed") {
        await stream.writeSSE({
          event: project.initStatus === "completed" ? "done" : "error",
          data: JSON.stringify({ status: project.initStatus }),
        });
        return;
      }

      // Subscribe to live updates
      let resolve: () => void;
      const done = new Promise<void>((r) => { resolve = r; });

      const unsub = subscribe(id, async (event) => {
        try {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
          });
          if (event.type === "done" || event.type === "error") {
            resolve!();
          }
        } catch {
          // Stream closed by client
          resolve!();
        }
      });

      stream.onAbort(() => {
        unsub();
        resolve!();
      });

      await done;
      unsub();
    });
  });
}
