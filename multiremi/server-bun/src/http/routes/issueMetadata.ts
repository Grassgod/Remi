/**
 * Issue metadata routes — port of the Go issue-metadata handler
 * (server/internal/handler/issue_metadata.go). Per-issue metadata is a small
 * JSONB object agents use to record pipeline state (PR number, pipeline_status,
 * waiting_on, ...). There is no separate table — it lives in issue.metadata,
 * an object column with DB CHECKs: jsonb_typeof = 'object' and
 * pg_column_size <= 8192.
 *
 * Declared on absolute /api/issues/:id/metadata paths in a standalone factory
 * so it composes alongside issueRoutes without editing that file. Behind the
 * /api/* JWT gate; scoped to a workspace via X-Workspace-ID + a membership
 * check, exactly like issueRoutes.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { issue } from "../../db/schema.js";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Normalize the stored metadata blob into a plain object for serialization.
 * The DB CHECK guarantees object shape, so this only degrades non-object rows
 * (which shouldn't exist) to an empty object — mirrors Go's parseIssueMetadata.
 */
function asMetadataObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** A plain JSON object (not null, not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function issueMetadataRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/issues/:id/metadata -> { metadata: {...} }
  r.get("/api/issues/:id/metadata", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    return c.json({ metadata: asMetadataObject(found.metadata) });
  });

  // PUT /api/issues/:id/metadata with body { metadata: {...} } -> { metadata: {...} }.
  // Merges the provided object into the issue's existing metadata (Go's per-key
  // writes are non-destructive jsonb_set upserts; the whole-blob form keeps the
  // same merge semantics so concurrent unrelated keys survive). The metadata
  // field must be a plain object; non-objects are rejected with 400.
  r.put("/api/issues/:id/metadata", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const incoming = body.metadata;
    if (!isPlainObject(incoming)) {
      return c.json({ error: "metadata must be an object" }, 400);
    }

    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const merged = { ...asMetadataObject(found.metadata), ...incoming };

    let updated;
    try {
      [updated] = await db
        .update(issue)
        .set({ metadata: merged, updatedAt: sql`now()` })
        .where(eq(issue.id, found.id))
        .returning();
    } catch (err) {
      // The 8KB size CHECK (issue_metadata_size_limit) surfaces as a check
      // violation; translate it into a clear 400 instead of a 500.
      if (isCheckViolation(err)) {
        return c.json({ error: "metadata exceeds the 8KB size limit" }, 400);
      }
      throw err;
    }

    const metadata = asMetadataObject(updated?.metadata ?? merged);
    bus.publish({
      type: "issue_metadata:changed",
      workspaceId: ws,
      payload: { issue_id: found.id, metadata },
    });
    return c.json({ metadata });
  });

  return r;
}

/** postgres-js surfaces a CHECK violation as SQLSTATE 23514. */
function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23514"
  );
}
