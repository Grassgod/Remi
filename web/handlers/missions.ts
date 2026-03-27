import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { MissionStore } from "../../src/mission/store.js";
import type { MissionStatus, PipelineStep } from "../../src/mission/model.js";
import { getDb } from "../../src/db/index.js";

const store = new MissionStore();

export function registerMissionsHandlers(app: Hono, _data: RemiData) {
  // GET /api/v1/missions — List missions with optional filters
  app.get("/api/v1/missions", (c) => {
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");

    let missions;
    if (projectId) {
      missions = store.listByProject(projectId);
      if (status) {
        missions = missions.filter((m) => m.status === status);
      }
    } else if (status) {
      missions = store.listByStatus(status as MissionStatus);
    } else {
      // No filters — list all missions ordered by updated_at desc
      const db = getDb();
      const rows = db
        .query("SELECT * FROM missions ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];
      missions = rows.map((row) => store.getById(row.id as string)!);
    }

    return c.json(missions);
  });

  // GET /api/v1/missions/stats — Project stats (must be before :id route)
  app.get("/api/v1/missions/stats", (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId query param is required" }, 400);
    }
    const stats = store.getProjectStats(projectId);
    return c.json(stats);
  });

  // GET /api/v1/missions/:id — Get single mission
  app.get("/api/v1/missions/:id", (c) => {
    const id = c.req.param("id");
    const mission = store.getById(id);
    if (!mission) {
      return c.json({ error: "Mission not found" }, 404);
    }
    return c.json(mission);
  });

  // POST /api/v1/missions — Create mission
  app.post("/api/v1/missions", async (c) => {
    const body = await c.req.json();
    const { title, projectId, chatId, threadId, description } = body;

    if (!title || !projectId || !chatId) {
      return c.json(
        { error: "title, projectId, and chatId are required" },
        400,
      );
    }

    const mission = store.create({
      title,
      projectId,
      chatId,
      threadId,
      description,
    });

    return c.json(mission, 201);
  });

  // PATCH /api/v1/missions/:id — Update mission
  app.patch("/api/v1/missions/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.getById(id);
    if (!existing) {
      return c.json({ error: "Mission not found" }, 404);
    }

    const body = await c.req.json();
    const fields: Partial<{
      title: string;
      description: string;
      status: MissionStatus;
      currentStep: PipelineStep;
    }> = {};

    if (body.status !== undefined) fields.status = body.status;
    if (body.title !== undefined) fields.title = body.title;
    if (body.description !== undefined) fields.description = body.description;
    if (body.currentStep !== undefined) fields.currentStep = body.currentStep;

    store.update(id, fields);
    return c.json({ ok: true });
  });

  // DELETE /api/v1/missions/:id — Delete mission
  app.delete("/api/v1/missions/:id", (c) => {
    const id = c.req.param("id");
    const existing = store.getById(id);
    if (!existing) {
      return c.json({ error: "Mission not found" }, 404);
    }

    store.delete(id);
    return c.json({ ok: true });
  });
}
