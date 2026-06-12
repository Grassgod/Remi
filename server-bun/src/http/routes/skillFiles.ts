/**
 * Skill file routes — port of skill.go ListSkillFiles/UpsertSkillFile/DeleteSkillFile:
 *   GET    /api/skills/:id/files            → a skill's files
 *   PUT    /api/skills/:id/files            → upsert files ({ files: [{path, content}] })
 *   DELETE /api/skills/:id/files/:fileId    → remove one file
 *
 * Standalone factory (absolute /api/* paths, mounted at "/" behind the JWT
 * gate). Workspace-scoped via X-Workspace-ID; the skill must live in that
 * workspace.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  deleteSkillFile,
  getSkillInWorkspace,
  listSkillFiles,
  upsertSkillFiles,
  type SkillFile,
} from "../../db/queries/skillFiles.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileToResponse(f: SkillFile) {
  return { id: f.id, skill_id: f.skillId, path: f.path, content: f.content, created_at: f.createdAt, updated_at: f.updatedAt };
}

async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) return c.json({ error: "X-Workspace-ID header required" }, 400);
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

export function skillFileRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const loadSkill = async (c: Context<AppEnv>): Promise<{ wsId: string; skillId: string } | Response> => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const skillId = c.req.param("id");
    if (!skillId || !UUID_RE.test(skillId)) return c.json({ error: "skill id is required" }, 400);
    const s = await getSkillInWorkspace(db, ws, skillId);
    if (!s) return c.json({ error: "skill not found" }, 404);
    return { wsId: ws, skillId: s.id };
  };

  r.get("/api/skills/:id/files", async (c) => {
    const gate = await loadSkill(c);
    if (gate instanceof Response) return gate;
    const files = await listSkillFiles(db!, gate.skillId);
    return c.json(files.map(fileToResponse));
  });

  r.put("/api/skills/:id/files", async (c) => {
    const gate = await loadSkill(c);
    if (gate instanceof Response) return gate;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const raw = body.files;
    if (!Array.isArray(raw)) return c.json({ error: "files must be an array" }, 400);
    const files: { path: string; content: string }[] = [];
    for (const f of raw) {
      const path = (f as { path?: unknown })?.path;
      const content = (f as { content?: unknown })?.content;
      if (typeof path !== "string" || !path.trim() || typeof content !== "string") {
        return c.json({ error: "each file needs a non-empty path and string content" }, 400);
      }
      files.push({ path: path.trim(), content });
    }

    await upsertSkillFiles(db!, gate.skillId, files);
    bus.publish({ type: "skill.files_changed", workspaceId: gate.wsId, payload: { skill_id: gate.skillId } });
    const all = await listSkillFiles(db!, gate.skillId);
    return c.json(all.map(fileToResponse));
  });

  r.delete("/api/skills/:id/files/:fileId", async (c) => {
    const gate = await loadSkill(c);
    if (gate instanceof Response) return gate;
    const fileId = c.req.param("fileId");
    if (!fileId || !UUID_RE.test(fileId)) return c.json({ error: "file id is required" }, 400);
    const removed = await deleteSkillFile(db!, gate.skillId, fileId);
    if (!removed) return c.json({ error: "file not found" }, 404);
    bus.publish({ type: "skill.files_changed", workspaceId: gate.wsId, payload: { skill_id: gate.skillId } });
    return c.body(null, 204);
  });

  return r;
}
