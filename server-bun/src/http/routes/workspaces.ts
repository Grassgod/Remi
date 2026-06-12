/**
 * Workspace routes (multi-tenancy). Behind the /api/* JWT gate, so the authed
 * user is on the context. Port of the Go workspace handler (list + create).
 */

import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Workspace } from "../../db/schema.js";
import { listWorkspacesForUser, createWorkspace } from "../../db/queries/workspace.js";

// Single-word reserved root slugs (mirrors server/internal/handler/reserved_slugs.json
// intent; the canonical list ships from the Go side — kept minimal here).
const RESERVED = new Set([
  "login", "inbox", "workspaces", "settings", "api", "auth", "health", "admin",
]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Full WorkspaceResponse shape (mirrors Go workspace.go's WorkspaceResponse).
function toResponse(ws: Workspace) {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    description: ws.description,
    issue_prefix: ws.issuePrefix,
    settings: ws.settings,
    context: ws.context,
    repos: ws.repos,
    avatar_url: ws.avatarUrl,
    created_at: ws.createdAt,
    updated_at: ws.updatedAt,
  };
}

export function workspaceRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const list = await listWorkspacesForUser(db, c.get("user").sub);
    return c.json(list.map(toResponse));
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; slug?: string; description?: string };
    const name = (body.name ?? "").trim();
    const slug = (body.slug ?? "").trim().toLowerCase();
    if (!name || !slug) return c.json({ error: "name and slug are required" }, 400);
    // Reserved + malformed slugs are client errors (400), not conflicts (409).
    if (RESERVED.has(slug)) return c.json({ error: "slug is reserved" }, 400);
    if (!SLUG_RE.test(slug)) return c.json({ error: "slug must be lowercase alphanumeric/hyphen" }, 400);
    try {
      const ws = await createWorkspace(db, { name, slug, description: body.description }, c.get("user").sub);
      return c.json(toResponse(ws), 201);
    } catch {
      // unique-violation on slug (or any insert failure)
      return c.json({ error: "slug already taken" }, 409);
    }
  });

  return r;
}
