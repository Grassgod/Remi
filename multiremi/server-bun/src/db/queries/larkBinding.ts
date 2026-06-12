/**
 * Lark binding-token + installation-admin queries — port of the Go
 * lark.BindingTokenService.RedeemAndBind and the InstallationService's
 * GetInWorkspace / Revoke (the DB-backed pieces of the integration settings;
 * the device-flow install needs the live Lark registration client and is NOT
 * ported).
 *
 * RedeemAndBind is transactional: consuming the token and inserting the
 * lark_user_binding row commit together, so a failed bind never burns a token
 * and a successful bind never leaves a consumed-but-unused token behind.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { larkBindingToken, larkInstallation, larkUserBinding } from "../schema.js";

export type LarkBindingTokenRow = typeof larkBindingToken.$inferSelect;
export type LarkUserBindingRow = typeof larkUserBinding.$inferSelect;
export type LarkInstallationRow = typeof larkInstallation.$inferSelect;

/** SHA-256 hex of the raw token — only the hash is ever stored (mirrors Go
 *  hashToken). Exported so tests can mint fixture rows for a known raw value. */
export function hashBindingToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Typed outcome of a redemption — the route maps these onto Go's status
 *  codes: invalid → 410, conflict → 409, not_member → 403. */
export type RedeemOutcome =
  | { ok: true; workspaceId: string; installationId: string; larkOpenId: string }
  | { ok: false; reason: "invalid" | "conflict" | "not_member" };

/** Internal sentinel: thrown inside the tx so the token consumption rolls
 *  back when the open_id is already bound to a different user (Go keeps the
 *  token unburned in that case so ops can revoke it explicitly). */
class RedeemConflictError extends Error {
  constructor() {
    super("lark open_id is already bound to a different user");
  }
}

/** SQLSTATE from a driver error — drizzle may wrap the postgres.js error, so
 *  the code can live on `.code` or `.cause.code` (same dual check as
 *  routes/projectResources.ts). */
function pgErrorCode(err: unknown): string | undefined {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e
      ? String((e as { code: unknown }).code)
      : undefined;
  const direct = code(err);
  if (direct) return direct;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause);
}

/**
 * Atomically consume a raw binding token and write the lark_user_binding row.
 * The redeemer's identity is the supplied userId (taken from the session by
 * the route, never from the token), so a stolen token cannot bind a Lark
 * open_id to an attacker's account. Mirrors Go RedeemAndBind:
 *
 *   - invalid:    token unknown / already consumed / expired. One opaque
 *                 outcome for all three (no replay-timing oracle).
 *   - conflict:   the (installation, open_id) pair is bound to a DIFFERENT
 *                 user. Rolled back — the token is NOT consumed.
 *   - not_member: the redeemer is not a member of the token's workspace —
 *                 the composite FK to member(workspace_id, user_id) trips
 *                 (SQLSTATE 23503). Rolled back identically.
 */
export async function redeemAndBind(db: Db, raw: string, userId: string): Promise<RedeemOutcome> {
  try {
    return await db.transaction(async (tx): Promise<RedeemOutcome> => {
      // Atomic consume: UPDATE … RETURNING means two simultaneous redemptions
      // of one token cannot both succeed — exactly one row update wins.
      const [token] = await tx
        .update(larkBindingToken)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(larkBindingToken.tokenHash, hashBindingToken(raw)),
            isNull(larkBindingToken.consumedAt),
            sql`${larkBindingToken.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!token) return { ok: false, reason: "invalid" };

      // ON CONFLICT DO UPDATE is gated on multimira_user_id matching the
      // existing binding (same-user re-bind stays an idempotent metadata
      // refresh); a cross-user grab updates zero rows and RETURNING comes
      // back empty — mirrors the Go CreateLarkUserBinding query.
      const inserted = await tx
        .insert(larkUserBinding)
        .values({
          workspaceId: token.workspaceId,
          multimiraUserId: userId,
          installationId: token.installationId,
          larkOpenId: token.larkOpenId,
        })
        .onConflictDoUpdate({
          target: [larkUserBinding.installationId, larkUserBinding.larkOpenId],
          set: {
            unionId: sql`COALESCE(EXCLUDED.union_id, ${larkUserBinding.unionId})`,
            boundAt: sql`now()`,
          },
          setWhere: sql`${larkUserBinding.multimiraUserId} = EXCLUDED.multimira_user_id`,
        })
        .returning();
      if (inserted.length === 0) throw new RedeemConflictError();

      return {
        ok: true,
        workspaceId: token.workspaceId,
        installationId: token.installationId,
        larkOpenId: token.larkOpenId,
      };
    });
  } catch (err) {
    if (err instanceof RedeemConflictError) return { ok: false, reason: "conflict" };
    // 23503 foreign_key_violation: lark_user_binding_member_fk — the redeemer
    // is not (or no longer) a member of the token's workspace.
    if (pgErrorCode(err) === "23503") return { ok: false, reason: "not_member" };
    throw err;
  }
}

/** Workspace-scoped installation lookup — one workspace cannot revoke
 *  another's installation by guessing the UUID (mirrors Go GetInWorkspace). */
export async function getLarkInstallationInWorkspace(
  db: Db,
  id: string,
  wsId: string,
): Promise<LarkInstallationRow | null> {
  const [row] = await db
    .select()
    .from(larkInstallation)
    .where(and(eq(larkInstallation.id, id), eq(larkInstallation.workspaceId, wsId)));
  return row ?? null;
}

/** Flip an installation to 'revoked' (row preserved for audit; a re-install
 *  flips it back). Mirrors Go InstallationService.Revoke → SetLarkInstallationStatus. */
export async function revokeLarkInstallation(db: Db, id: string): Promise<void> {
  await db
    .update(larkInstallation)
    .set({ status: "revoked", updatedAt: sql`now()` })
    .where(eq(larkInstallation.id, id));
}
