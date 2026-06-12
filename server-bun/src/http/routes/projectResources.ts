/**
 * Project resource routes — port of the Go project_resource handler:
 *   GET    /api/projects/{id}/resources               (h.ListProjectResources)
 *   POST   /api/projects/{id}/resources               (h.CreateProjectResource)
 *   PUT    /api/projects/{id}/resources/{resourceId}  (h.UpdateProjectResource)
 *   DELETE /api/projects/{id}/resources/{resourceId}  (h.DeleteProjectResource)
 *
 * All declare absolute paths (like memberRoutes) → mount at "/". Behind the
 * /api/* JWT gate; member-level workspace access. A resource binds a project
 * to a place an agent runs: `github_repo` (fresh worktree from a git URL) or
 * `local_directory` (run in-place on one daemon's machine).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Project } from "../../db/schema.js";
import { getMembership } from "../../db/queries/issues.js";
import { getProjectInWorkspace } from "../../db/queries/projects.js";
import {
  countProjectResources,
  createProjectResource,
  deleteProjectResource,
  getProjectResourceInWorkspace,
  listProjectResources,
  updateProjectResource,
  type ProjectResource,
} from "../../db/queries/projectResources.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go ProjectResourceResponse struct (snake_case JSON). */
function resourceToResponse(r: ProjectResource) {
  return {
    id: r.id,
    project_id: r.projectId,
    workspace_id: r.workspaceId,
    resource_type: r.resourceType,
    resource_ref: r.resourceRef ?? {},
    label: r.label,
    position: r.position,
    created_at: r.createdAt,
    created_by: r.createdBy,
  };
}

/**
 * Postgres unique-violation detection (mirrors Go isUniqueViolation). Drizzle
 * wraps the driver error, so SQLSTATE "23505" lives on `.cause.code`;
 * postgres.js surfaces it on `.code` directly. Check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): unknown =>
    typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause: unknown }).cause : undefined;
  return code(cause) === "23505";
}

type JsonObject = Record<string, unknown>;

type NormalizedRef = { ok: true; ref: JsonObject } | { ok: false; error: string };

/**
 * Validate the payload for a known resource_type and re-marshal only the
 * known fields (mirrors Go validateAndNormalizeResourceRef — unknown types
 * are rejected at the API boundary so a typo can't produce a resource the
 * daemon/UI doesn't understand).
 */
function validateAndNormalizeResourceRef(resourceType: string, ref: unknown): NormalizedRef {
  if (ref === undefined) return { ok: false, error: "resource_ref is required" };
  switch (resourceType) {
    case "github_repo":
      return validateGithubRepoRef(ref);
    case "local_directory":
      return validateLocalDirectoryRef(ref);
    default:
      return { ok: false, error: `unknown resource_type "${resourceType}"` };
  }
}

/** A JSON value Go would unmarshal into a struct without error: an object or
 * literal null (null leaves the zero values, caught by the field checks). */
function asRefObject(ref: unknown): JsonObject | null {
  if (ref === null) return {};
  if (typeof ref === "object" && !Array.isArray(ref)) return ref as JsonObject;
  return null;
}

/** An optional string field: absent/null → "", string → itself, else a type
 * error (Go json.Unmarshal fails on a wrong-typed field). */
function optString(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : null;
}

function validateGithubRepoRef(ref: unknown): NormalizedRef {
  const obj = asRefObject(ref);
  if (!obj) return { ok: false, error: "invalid github_repo payload" };
  const rawUrl = optString(obj.url);
  const rawHint = optString(obj.default_branch_hint);
  if (rawUrl === null || rawHint === null) {
    return { ok: false, error: "invalid github_repo payload" };
  }
  const url = rawUrl.trim();
  if (!url) return { ok: false, error: "github_repo: url is required" };
  if (!isValidGitRepoURL(url)) {
    return { ok: false, error: "github_repo: url must be a valid http(s) or ssh git URL" };
  }
  const hint = rawHint.trim();
  const out: JsonObject = { url };
  if (hint) out.default_branch_hint = hint; // omitempty
  return { ok: true, ref: out };
}

/**
 * The JSONB shape stored for resource_type=local_directory: pins a project to
 * an existing directory on one daemon's machine, so agent tasks run in-place
 * rather than in an isolated git worktree (mirrors Go localDirectoryRef).
 */
function validateLocalDirectoryRef(ref: unknown): NormalizedRef {
  const obj = asRefObject(ref);
  if (!obj) return { ok: false, error: "invalid local_directory payload" };
  const rawPath = optString(obj.local_path);
  const rawDaemon = optString(obj.daemon_id);
  const rawLabel = optString(obj.label);
  if (rawPath === null || rawDaemon === null || rawLabel === null) {
    return { ok: false, error: "invalid local_directory payload" };
  }
  const localPath = rawPath.trim();
  if (!localPath) return { ok: false, error: "local_directory: local_path is required" };
  if (!isAbsoluteLocalPath(localPath)) {
    return { ok: false, error: "local_directory: local_path must be an absolute path" };
  }
  const daemonId = rawDaemon.trim();
  if (!daemonId) return { ok: false, error: "local_directory: daemon_id is required" };
  const label = rawLabel.trim();
  const out: JsonObject = { local_path: localPath, daemon_id: daemonId };
  if (label) out.label = label; // omitempty
  return { ok: true, ref: out };
}

/**
 * The path looks absolute on either POSIX or Windows daemons (the server
 * can't know the daemon's OS, so accept the union): leading "/", a UNC
 * prefix "\\", or a drive letter like "C:\" — a typo guard, not a
 * filesystem check (mirrors Go isAbsoluteLocalPath).
 */
function isAbsoluteLocalPath(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("/")) return true;
  if (s.startsWith("\\\\")) return true;
  if (s.length >= 3 && /[a-zA-Z]/.test(s[0]!) && s[1] === ":" && (s[2] === "\\" || s[2] === "/")) {
    return true;
  }
  return false;
}

/**
 * Accepts the three forms a user can paste from GitHub's "Code" menu:
 * https://, ssh:// (explicit scheme), and the scp-like `git@host:owner/repo`
 * shorthand. Intentionally lax — `git clone` gives the clearer error
 * (mirrors Go isValidGitRepoURL).
 */
function isValidGitRepoURL(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.host !== "" && ["http:", "https:", "ssh:", "git:"].includes(u.protocol)) return true;
  } catch {
    /* not a scheme URL — try the scp-like shorthand below */
  }
  // scp-like ssh shorthand: [user@]host:path with non-empty host and path,
  // no spaces, and no scheme separator.
  if (s.includes(" ") || s.includes("://")) return false;
  const colon = s.indexOf(":");
  if (colon <= 0 || colon === s.length - 1) return false;
  // `@` is only meaningful as a user separator before the first ':'.
  const at = s.indexOf("@");
  if (at >= colon) return false;
  const hostStart = at >= 0 ? at + 1 : 0;
  const host = s.slice(hostStart, colon);
  const path = s.slice(colon + 1);
  return host !== "" && path !== "";
}

/**
 * Enforce "at most one local_directory resource per (project, daemon)" — the
 * daemon picks the first matching daemon_id row out of a task's resources, so
 * two rows for one daemon would mean the agent silently writes into whichever
 * comes back first. The DB UNIQUE constraint only fires on full ref-JSON
 * equality, so this daemon-scoped check lives in application code (mirrors Go
 * findLocalDirectoryConflict). `excludeId` lets the update path ignore the
 * row being edited.
 */
async function findLocalDirectoryConflict(
  db: Db,
  projectId: string,
  resourceType: string,
  normalizedRef: JsonObject,
  excludeId: string | null,
): Promise<boolean> {
  if (resourceType !== "local_directory") return false;
  const incoming = normalizedRef.daemon_id;
  const rows = await listProjectResources(db, projectId);
  for (const row of rows) {
    if (row.resourceType !== "local_directory") continue;
    if (excludeId && row.id === excludeId) continue;
    const existing = row.resourceRef;
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) continue;
    if ((existing as JsonObject).daemon_id === incoming) return true;
  }
  return false;
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

/** Resolve the project in the path, enforcing workspace ownership (mirrors Go
 * loadProjectForResource). */
async function requireProject(c: Context<AppEnv>, db: Db, wsId: string): Promise<Project | Response> {
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const found = await getProjectInWorkspace(db, wsId, id);
  if (!found) return c.json({ error: "project not found" }, 404);
  return found;
}

/** Resolve the resource in the path within the project (Go's workspace-scoped
 * lookup + project-id match — both misses collapse to the same 404). */
async function requireResource(
  c: Context<AppEnv>,
  db: Db,
  project: Project,
): Promise<ProjectResource | Response> {
  const resourceId = c.req.param("resourceId");
  if (!resourceId || !UUID_RE.test(resourceId)) {
    return c.json({ error: "invalid resource id" }, 400);
  }
  const existing = await getProjectResourceInWorkspace(db, resourceId, project.workspaceId);
  if (!existing || existing.projectId !== project.id) {
    return c.json({ error: "project resource not found" }, 404);
  }
  return existing;
}

export function projectResourcesRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/projects/:id/resources — the resources attached to a project,
  // ordered by position (mirrors Go ListProjectResources).
  r.get("/api/projects/:id/resources", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const project = await requireProject(c, db, ws);
    if (project instanceof Response) return project;

    const rows = await listProjectResources(db, project.id);
    const resources = rows.map(resourceToResponse);
    return c.json({ resources, total: resources.length });
  });

  // POST /api/projects/:id/resources — attach a new resource (mirrors Go
  // CreateProjectResource). 201 on success; 409 on duplicate ref or a second
  // local_directory for the same daemon.
  r.post("/api/projects/:id/resources", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const project = await requireProject(c, db, ws);
    if (project instanceof Response) return project;

    let body: JsonObject;
    try {
      body = (await c.req.json()) as JsonObject;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const resourceType = typeof body.resource_type === "string" ? body.resource_type.trim() : "";
    if (!resourceType) return c.json({ error: "resource_type is required" }, 400);

    const normalized = validateAndNormalizeResourceRef(resourceType, body.resource_ref);
    if (!normalized.ok) return c.json({ error: normalized.error }, 400);

    if (await findLocalDirectoryConflict(db, project.id, resourceType, normalized.ref, null)) {
      return c.json(
        { error: "this daemon already has a local_directory attached to the project; remove it before adding another" },
        409,
      );
    }

    // Go decodes label into *string — a wrong-typed field fails the decode.
    if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
      return c.json({ error: "invalid request body" }, 400);
    }
    const label =
      typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;

    // Go decodes position into *int32 — non-integers fail the decode.
    if (
      body.position !== undefined &&
      body.position !== null &&
      (typeof body.position !== "number" || !Number.isInteger(body.position))
    ) {
      return c.json({ error: "invalid request body" }, 400);
    }
    const position =
      typeof body.position === "number"
        ? body.position
        : await countProjectResources(db, project.id); // append after existing

    let resource: ProjectResource;
    try {
      resource = await createProjectResource(db, {
        projectId: project.id,
        workspaceId: project.workspaceId,
        resourceType,
        resourceRef: normalized.ref,
        label,
        position,
        createdBy: c.get("user").sub,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "this resource is already attached to the project" }, 409);
      }
      throw err;
    }

    const resp = resourceToResponse(resource);
    bus.publish({
      type: "project_resource.created",
      workspaceId: project.workspaceId,
      payload: { resource: resp, project_id: project.id },
    });
    return c.json(resp, 201);
  });

  // PUT /api/projects/:id/resources/:resourceId — edit ref/label/position
  // (mirrors Go UpdateProjectResource). resource_type is immutable — delete
  // and re-add to change it. Omitted fields keep their current value; for
  // label, explicit null / "" clears it.
  r.put("/api/projects/:id/resources/:resourceId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const project = await requireProject(c, db, ws);
    if (project instanceof Response) return project;
    const existing = await requireResource(c, db, project);
    if (existing instanceof Response) return existing;

    let body: JsonObject;
    try {
      body = (await c.req.json()) as JsonObject;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // "field omitted" vs "field present with zero value" matters here — the
    // label clear case in particular relies on the distinction (mirrors Go's
    // raw-map decode).
    let nextRef = existing.resourceRef as JsonObject;
    if ("resource_ref" in body) {
      const normalized = validateAndNormalizeResourceRef(existing.resourceType, body.resource_ref);
      if (!normalized.ok) return c.json({ error: normalized.error }, 400);
      nextRef = normalized.ref;
    }

    if (await findLocalDirectoryConflict(db, project.id, existing.resourceType, nextRef, existing.id)) {
      return c.json(
        { error: "another local_directory on this daemon is already attached to the project" },
        409,
      );
    }

    let nextLabel = existing.label;
    if ("label" in body) {
      const raw = body.label;
      if (raw !== null && typeof raw !== "string") {
        return c.json({ error: "label must be a string or null" }, 400);
      }
      nextLabel = raw === null || raw.trim() === "" ? null : raw.trim();
    }

    let nextPosition = existing.position;
    if ("position" in body) {
      const raw = body.position;
      if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw))) {
        return c.json({ error: "position must be an integer" }, 400);
      }
      if (raw !== null) nextPosition = raw;
    }

    let updated: ProjectResource | null;
    try {
      updated = await updateProjectResource(db, existing.id, {
        resourceRef: nextRef,
        label: nextLabel,
        position: nextPosition,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "this resource is already attached to the project" }, 409);
      }
      throw err;
    }

    const resp = resourceToResponse(updated ?? existing);
    bus.publish({
      type: "project_resource.updated",
      workspaceId: project.workspaceId,
      payload: { resource: resp, project_id: project.id },
    });
    return c.json(resp);
  });

  // DELETE /api/projects/:id/resources/:resourceId — remove a resource
  // (mirrors Go DeleteProjectResource). 204 on success.
  r.delete("/api/projects/:id/resources/:resourceId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const project = await requireProject(c, db, ws);
    if (project instanceof Response) return project;
    const resource = await requireResource(c, db, project);
    if (resource instanceof Response) return resource;

    await deleteProjectResource(db, resource.id);
    bus.publish({
      type: "project_resource.deleted",
      workspaceId: project.workspaceId,
      payload: { project_id: project.id, resource_id: resource.id },
    });
    return c.body(null, 204);
  });

  return r;
}
