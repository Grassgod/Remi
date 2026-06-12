/**
 * Skill routes (read path) — port of the Go skill handler's GET /api/skills
 * (list) and GET /api/skills/{id} (get). Behind the /api/* JWT gate; scoped to
 * a workspace via the X-Workspace-ID header + a membership check (multi-tenancy).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  createSkill,
  deleteSkill,
  getSkillInWorkspace,
  listSkillFiles,
  listSkillSummariesByWorkspace,
  updateSkill,
  type Skill,
  type SkillFile,
  type SkillSummary,
} from "../../db/queries/skills.js";
import { upsertSkillFiles } from "../../db/queries/skillFiles.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A skill fetched from an external source (GitHub/ClawHub/raw URL). */
export interface ImportedSkill {
  name: string;
  description: string;
  content: string; // the SKILL.md body
  files: { path: string; content: string }[];
  origin?: Record<string, unknown>;
}

/** Fetches + parses a skill from a URL. The concrete multi-source fetcher needs
 *  network access (GitHub/ClawHub/raw); injected as a fake in tests. */
export interface SkillFetcher {
  fetch(url: string): Promise<ImportedSkill>;
}

const unconfiguredFetcher: SkillFetcher = {
  async fetch() {
    throw new Error("skill import source fetching is not configured");
  },
};

/**
 * Normalize a JSONB skill.config blob to a JSON object. Mirrors Go
 * decodeSkillConfig: missing/null defaults to {} so the API surface always
 * returns an object.
 */
function decodeSkillConfig(raw: unknown): unknown {
  return raw ?? {};
}

/**
 * Mirrors the Go SkillSummaryResponse struct (snake_case JSON): everything
 * SkillResponse has except `content`, used by the list endpoint.
 */
function skillSummaryToResponse(s: SkillSummary) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    name: s.name,
    description: s.description,
    config: decodeSkillConfig(s.config),
    created_by: s.createdBy,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors the Go SkillResponse struct (snake_case JSON), including `content`. */
function skillToResponse(s: Skill) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    name: s.name,
    description: s.description,
    content: s.content,
    config: decodeSkillConfig(s.config),
    created_by: s.createdBy,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** Mirrors the Go SkillFileResponse struct (snake_case JSON). */
function skillFileToResponse(f: SkillFile) {
  return {
    id: f.id,
    skill_id: f.skillId,
    path: f.path,
    content: f.content,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505) — here, the
 * UNIQUE(workspace_id, name) skill index. Drizzle wraps driver errors in a
 * DrizzleQueryError, so the SQLSTATE code can live on `cause`; check both.
 * Mirrors the Go isUniqueViolation → 409 mapping.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}

export function skillRoutes(db?: Db, fetcher: SkillFetcher = unconfiguredFetcher): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const skills = await listSkillSummariesByWorkspace(db, ws);
    return c.json(skills.map(skillSummaryToResponse));
  });

  // POST /api/skills/import { url } — fetch a skill from an external source and
  // persist it (skill row + its files). The fetch is delegated to the injected
  // SkillFetcher; the persistence (conflict/files) is what this route owns.
  r.post("/import", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return c.json({ error: "url is required" }, 400);

    let imported: ImportedSkill;
    try {
      imported = await fetcher.fetch(url);
    } catch {
      return c.json({ error: "one or more skill sources are unavailable" }, 422);
    }
    if (!imported.name?.trim()) return c.json({ error: "fetched skill has no name" }, 422);

    let created: Skill;
    try {
      created = await createSkill(db, {
        workspaceId: ws,
        name: imported.name,
        description: imported.description ?? "",
        content: imported.content ?? "",
        config: (imported.origin ? { origin: imported.origin } : {}) as Skill["config"],
        createdBy: c.get("user").sub,
      });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "a skill with this name already exists" }, 409);
      throw err;
    }

    if (imported.files?.length) {
      await upsertSkillFiles(db, created.id, imported.files.filter((f) => f.path?.trim()));
    }
    bus.publish({ type: "skill.created", workspaceId: ws, payload: { id: created.id } });
    const files = await listSkillFiles(db, created.id);
    return c.json({ ...skillToResponse(created), files: files.map(skillFileToResponse) }, 201);
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    // Mirror Go CreateSkillRequest: description/content default to "" (NOT NULL
    // columns); config defaults to {} via decodeSkillConfig on the way out.
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    let created: Skill;
    try {
      created = await createSkill(db, {
        workspaceId: ws,
        name,
        description: str(body.description),
        content: str(body.content),
        config: (body.config ?? {}) as Skill["config"],
        createdBy: c.get("user").sub,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "a skill with this name already exists" }, 409);
      }
      throw err;
    }

    bus.publish({ type: "skill.created", workspaceId: ws, payload: { id: created.id } });
    // New skills have no supporting files yet; mirror Go's SkillWithFilesResponse.
    return c.json({ ...skillToResponse(created), files: [] }, 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid skill id" }, 400);

    const found = await getSkillInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "skill not found" }, 404);

    const files = await listSkillFiles(db, found.id);
    return c.json({
      ...skillToResponse(found),
      files: files.map(skillFileToResponse),
    });
  });

  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid skill id" }, 400);

    const found = await getSkillInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "skill not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // Partial update: only fields present in the body are touched (mirrors Go
    // UpdateSkillRequest's pointer fields + COALESCE in UpdateSkill). name,
    // description and content are NOT NULL, so a present field must be a string.
    const f: Partial<Pick<Skill, "name" | "description" | "content" | "config">> = {};
    if (typeof body.name === "string") f.name = body.name;
    if (typeof body.description === "string") f.description = body.description;
    if (typeof body.content === "string") f.content = body.content;
    if (body.config != null) f.config = body.config as Skill["config"];

    let updated: Skill | null;
    try {
      updated = await updateSkill(db, found.id, f);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "a skill with this name already exists" }, 409);
      }
      throw err;
    }

    const result = updated ?? found;
    bus.publish({ type: "skill.updated", workspaceId: ws, payload: { id: found.id } });
    const skillFiles = await listSkillFiles(db, result.id);
    return c.json({
      ...skillToResponse(result),
      files: skillFiles.map(skillFileToResponse),
    });
  });

  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid skill id" }, 400);

    const found = await getSkillInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "skill not found" }, 404);

    // workspace_id is a SQL-layer tenant guard (defense-in-depth, mirrors Go
    // DeleteSkill). skill_file rows cascade on delete.
    await deleteSkill(db, found.id, ws);
    bus.publish({ type: "skill.deleted", workspaceId: ws, payload: { id: found.id } });
    return c.body(null, 204);
  });

  return r;
}
