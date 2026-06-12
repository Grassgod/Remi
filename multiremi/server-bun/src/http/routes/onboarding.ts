/**
 * Onboarding routes — port of the Go onboarding handler
 * (server/internal/handler/onboarding.go, the primary user-level path).
 *
 * The only user-level onboarding endpoint that mutates state is
 * CompleteOnboarding, wired in Go's router as:
 *
 *   POST /api/me/onboarding/complete
 *
 * It idempotently marks the authenticated user (from the JWT) as having
 * completed onboarding. The underlying Go query (MarkUserOnboarded) uses
 *   onboarded_at = COALESCE(onboarded_at, now())
 * so the original timestamp is preserved on repeat calls — the endpoint is a
 * safe client-side retry target and always returns 200 with the user row.
 *
 * This is a user-scoped endpoint, NOT a workspace-scoped one: there is no
 * X-Workspace-ID gate. The user is taken from `c.get("user").sub`. The Go
 * handler accepts an optional body { completion_path?, workspace_id? } used
 * purely as analytics dimensions — server state flips the same way regardless
 * — and validates workspace_id format when present. We keep that validation so
 * a malformed value fails fast, but no analytics are emitted from this port.
 *
 * Parity scope / "the rest", noted per the task:
 *   - PATCH /api/me/onboarding (PatchOnboarding — persists the questionnaire
 *     JSONB) — NOT ported here; this file ports the primary complete path only.
 *   - POST /api/me/onboarding/cloud-waitlist (JoinCloudWaitlist) — NOT ported;
 *     it is a side effect that does not complete onboarding.
 *   - POST /api/me/onboarding/runtime-bootstrap and
 *     POST /api/me/onboarding/no-runtime-bootstrap (onboarding_shim.go) —
 *     DEPRECATED desktop < v3 workspace-completion variants; NOT ported.
 *   - Go exposes NO GET onboarding-state endpoint; onboarding state is read via
 *     the user row (/api/me), so there is nothing to port on the GET side here.
 *
 * Standalone route factory declaring ABSOLUTE /api/me/onboarding* paths so it
 * composes alongside the existing routes without editing them. Behind the
 * /api/* JWT gate.
 */

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { user } from "../../db/schema.js";
import { userToResponse } from "../userResponse.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function onboardingRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // POST /api/me/onboarding/complete — idempotently mark the JWT user onboarded.
  r.post("/api/me/onboarding/complete", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const userId = c.get("user").sub;

    // Body is optional — an empty body is a legal call (legacy clients send
    // nothing). completion_path is an analytics-only dimension; workspace_id is
    // validated for format when present so a junk value fails fast, but neither
    // is written to user state.
    let body: { completion_path?: unknown; workspace_id?: unknown } = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    if (typeof body.workspace_id === "string" && body.workspace_id !== "") {
      if (!UUID_RE.test(body.workspace_id)) {
        return c.json({ error: "invalid workspace_id" }, 400);
      }
    }

    // COALESCE(onboarded_at, now()) preserves the original timestamp on repeat
    // calls, so this single statement is the idempotent mark — mirrors Go's
    // MarkUserOnboarded. The RETURNING row is the updated user.
    const [updated] = await db
      .update(user)
      .set({ onboardedAt: sql`COALESCE(${user.onboardedAt}, now())`, updatedAt: sql`now()` })
      .where(eq(user.id, userId))
      .returning();

    if (!updated) return c.json({ error: "user not found" }, 404);

    return c.json(userToResponse(updated));
  });

  return r;
}
