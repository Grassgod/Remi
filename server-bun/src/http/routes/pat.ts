/**
 * Personal access token routes — port of the Go PAT handler's
 * GET /api/personal-access-tokens (list), POST (create), and
 * DELETE /api/personal-access-tokens/:id (revoke). Behind the /api/* JWT gate.
 *
 * These are USER-scoped, not workspace-scoped: there is no X-Workspace-ID
 * header and no membership gate. Every query filters by the JWT subject
 * (c.get("user").sub), mirroring the Go handler's requireUserID + user_id
 * filter. A token belongs to a person, not a workspace.
 *
 * Token format matches the Go side exactly: "mul_" + 40 random hex chars, with
 * the stored value being the hex-encoded SHA-256 hash (auth.GeneratePATToken /
 * auth.HashToken). The plaintext token is returned once, on create, and never
 * again — only its prefix (first 12 chars) and hash are persisted.
 */

import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import {
  createPersonalAccessToken,
  listPersonalAccessTokensByUser,
  revokePersonalAccessToken,
  type PersonalAccessToken,
} from "../../db/queries/pat.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "mul_" + 40 random hex chars (mirrors auth.GeneratePATToken). */
function generatePATToken(): string {
  return "mul_" + randomBytes(20).toString("hex");
}

/** Hex-encoded SHA-256 of the token string (mirrors auth.HashToken). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mirrors the Go PersonalAccessTokenResponse struct (snake_case JSON). */
function patToResponse(p: PersonalAccessToken) {
  return {
    id: p.id,
    name: p.name,
    token_prefix: p.tokenPrefix,
    expires_at: p.expiresAt,
    last_used_at: p.lastUsedAt,
    created_at: p.createdAt,
  };
}

export function patRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const userId = c.get("user").sub;
    const pats = await listPersonalAccessTokensByUser(db, userId);
    return c.json(pats.map(patToResponse));
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const userId = c.get("user").sub;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    // Optional expiry window in days. Only a positive integer sets expires_at;
    // anything else leaves it NULL (a never-expiring token), matching the Go
    // `ExpiresInDays != nil && *ExpiresInDays > 0` guard.
    const days = typeof body.expires_in_days === "number" ? body.expires_in_days : 0;
    const expiresAt =
      days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

    const rawToken = generatePATToken();
    // Prefix = first 12 chars (mirrors the Go `rawToken[:12]` slice).
    const prefix = rawToken.slice(0, 12);

    const created = await createPersonalAccessToken(db, {
      userId,
      name,
      tokenHash: hashToken(rawToken),
      tokenPrefix: prefix,
      expiresAt,
    });

    // The plaintext token is surfaced exactly once, here. Only the hash is
    // stored, so it cannot be recovered later.
    return c.json({ ...patToResponse(created), token: rawToken }, 201);
  });

  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const userId = c.get("user").sub;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid token id" }, 400);
    // Revoke is idempotent: a missing row (wrong id or not the owner) still
    // returns 204, mirroring the Go handler's pgx.ErrNoRows branch.
    await revokePersonalAccessToken(db, id, userId);
    return c.body(null, 204);
  });

  return r;
}
