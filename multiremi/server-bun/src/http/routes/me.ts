/**
 * Current-user routes — port of Go GetMe / UpdateMe:
 *   GET   /api/me   — the full authenticated user record (NOT just JWT claims)
 *   PATCH /api/me   — update editable profile fields
 * The frontend bootstraps its session from GET /api/me and parses it against a
 * zod schema, so this must return the complete user object or the app treats
 * the session as logged-out.
 */

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { user } from "../../db/schema.js";
import { userToResponse } from "../userResponse.js";

export function meRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/api/me", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const [u] = await db.select().from(user).where(eq(user.id, c.get("user").sub));
    if (!u) return c.json({ error: "user not found" }, 404);
    return c.json(userToResponse(u));
  });

  r.patch("/api/me", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const fields: Record<string, unknown> = {};
    if (typeof body.name === "string") fields.name = body.name;
    if ("avatar_url" in body) fields.avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url : null;
    if ("language" in body) fields.language = typeof body.language === "string" ? body.language : null;
    if ("timezone" in body) fields.timezone = typeof body.timezone === "string" ? body.timezone : null;
    if (typeof body.profile_description === "string") fields.profileDescription = body.profile_description;
    if (Object.keys(fields).length === 0) {
      const [u] = await db.select().from(user).where(eq(user.id, c.get("user").sub));
      return u ? c.json(userToResponse(u)) : c.json({ error: "user not found" }, 404);
    }
    const [updated] = await db
      .update(user)
      .set({ ...fields, updatedAt: sql`now()` })
      .where(eq(user.id, c.get("user").sub))
      .returning();
    if (!updated) return c.json({ error: "user not found" }, 404);
    return c.json(userToResponse(updated));
  });

  return r;
}
