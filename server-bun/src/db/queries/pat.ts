/**
 * Personal access token queries — port of the Go PAT handler's read/write path
 * (list + create + revoke). User-scoped (no workspace), so these key on user_id,
 * not workspace_id. Mirrors server/pkg/db/queries/personal_access_token.sql.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { personalAccessToken } from "../schema.js";

/** personal_access_token has no exported $inferSelect type in schema.ts. */
export type PersonalAccessToken = typeof personalAccessToken.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessToken.$inferInsert;

export async function createPersonalAccessToken(
  db: Db,
  input: NewPersonalAccessToken,
): Promise<PersonalAccessToken> {
  const [p] = await db.insert(personalAccessToken).values(input).returning();
  return p!;
}

/**
 * List a user's active tokens, newest first (mirrors the Go
 * ListPersonalAccessTokensByUser: user_id match, revoked = FALSE,
 * ORDER BY created_at DESC).
 */
export async function listPersonalAccessTokensByUser(
  db: Db,
  userId: string,
): Promise<PersonalAccessToken[]> {
  return db
    .select()
    .from(personalAccessToken)
    .where(and(eq(personalAccessToken.userId, userId), eq(personalAccessToken.revoked, false)))
    .orderBy(desc(personalAccessToken.createdAt));
}

/**
 * Soft-revoke a token, scoped to its owner (mirrors the Go
 * RevokePersonalAccessToken: WHERE id = $1 AND user_id = $2). Returns the
 * revoked token's hash, or null when no row matched (wrong id or not the
 * owner) — the caller treats a no-match as an idempotent 204.
 */
export async function revokePersonalAccessToken(
  db: Db,
  id: string,
  userId: string,
): Promise<{ tokenHash: string } | null> {
  const [p] = await db
    .update(personalAccessToken)
    .set({ revoked: true })
    .where(and(eq(personalAccessToken.id, id), eq(personalAccessToken.userId, userId)))
    .returning({ tokenHash: personalAccessToken.tokenHash });
  return p ?? null;
}
