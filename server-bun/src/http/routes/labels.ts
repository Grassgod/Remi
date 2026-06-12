/**
 * Label routes (read path) — port of the Go issue-label handler's
 * GET /api/labels (list) and POST /api/labels (create). Behind the /api/* JWT
 * gate; scoped to a workspace via the X-Workspace-ID header + a membership
 * check (multi-tenancy).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { createLabel, listLabels, type Label } from "../../db/queries/labels.js";
import { getMembership } from "../../db/queries/issues.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 6-digit hex, with or without a leading '#'. Mirrors the Go hexColorRE.
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

const MAX_LABEL_NAME_LEN = 32;

function labelToResponse(l: Label) {
  return {
    id: l.id,
    workspace_id: l.workspaceId,
    name: l.name,
    color: l.color,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

/**
 * Trim + validate a label name (mirrors the Go validateLabelName). Returns the
 * trimmed name, or an error string suitable for a 400.
 */
function validateLabelName(raw: unknown): { name: string } | { error: string } {
  const name = (typeof raw === "string" ? raw : "").trim();
  if (!name) return { error: "name is required" };
  if (name.length > MAX_LABEL_NAME_LEN) return { error: "name must be 32 characters or fewer" };
  return { name };
}

/**
 * Normalize a color to canonical "#rrggbb" (mirrors the Go normalizeColor).
 *
 * LOAD-BEARING INVARIANT: the frontend LabelChip renders
 * style={{ backgroundColor: color }} directly. Keep this regex strict so the
 * inline style can never become an injection surface.
 */
function normalizeColor(raw: unknown): { color: string } | { error: string } {
  const c = (typeof raw === "string" ? raw : "").trim();
  if (!HEX_COLOR_RE.test(c)) {
    return { error: "color must be a 6-digit hex value like #3b82f6" };
  }
  const withHash = c.startsWith("#") ? c : `#${c}`;
  return { color: withHash.toLowerCase() };
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

export function labelRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const labels = await listLabels(db, ws);
    const resp = labels.map(labelToResponse);
    return c.json({ labels: resp, total: resp.length });
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
    const nameResult = validateLabelName(body.name);
    if ("error" in nameResult) return c.json({ error: nameResult.error }, 400);
    const colorResult = normalizeColor(body.color);
    if ("error" in colorResult) return c.json({ error: colorResult.error }, 400);

    try {
      const created = await createLabel(db, {
        workspaceId: ws,
        name: nameResult.name,
        color: colorResult.color,
      });
      return c.json(labelToResponse(created), 201);
    } catch (err) {
      // unique_violation (23505) → name collides within the workspace (the
      // issue_label_workspace_name_lower_idx unique index). Mirror the Go 409.
      if (isUniqueViolation(err)) {
        return c.json({ error: "a label with that name already exists" }, 409);
      }
      throw err;
    }
  });

  return r;
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Drizzle wraps
 * driver errors in a DrizzleQueryError, so the SQLSTATE code lives on `cause`,
 * not the top-level error — check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}
