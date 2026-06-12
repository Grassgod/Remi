/**
 * Issue reaction queries — port of the Go issue_reaction handler's write path
 * (AddIssueReaction / RemoveIssueReaction). All operations are keyed on the
 * already-resolved issue (the caller resolves + authorizes the issue within the
 * workspace first), so these functions never re-check tenancy themselves.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { issueReaction } from "../schema.js";

/** Row type for the issue_reaction table (not exported from schema.ts). */
export type IssueReaction = typeof issueReaction.$inferSelect;
type NewIssueReaction = typeof issueReaction.$inferInsert;

/**
 * Add a reaction (idempotent). Mirrors the Go AddIssueReaction: ON CONFLICT on
 * (issue_id, actor_type, actor_id, emoji) is a no-op update that preserves
 * created_at, so a repeated reaction returns the existing row instead of
 * erroring on the unique constraint.
 */
export async function addIssueReaction(db: Db, input: NewIssueReaction): Promise<IssueReaction> {
  const [r] = await db
    .insert(issueReaction)
    .values(input)
    .onConflictDoUpdate({
      target: [
        issueReaction.issueId,
        issueReaction.actorType,
        issueReaction.actorId,
        issueReaction.emoji,
      ],
      set: { createdAt: issueReaction.createdAt },
    })
    .returning();
  return r!;
}

/**
 * Remove a reaction by its natural key (issue + actor + emoji). Mirrors the Go
 * RemoveIssueReaction DELETE; idempotent (a missing row is a no-op).
 */
export async function removeIssueReaction(
  db: Db,
  issueId: string,
  actorType: string,
  actorId: string,
  emoji: string,
): Promise<void> {
  await db
    .delete(issueReaction)
    .where(
      and(
        eq(issueReaction.issueId, issueId),
        eq(issueReaction.actorType, actorType),
        eq(issueReaction.actorId, actorId),
        eq(issueReaction.emoji, emoji),
      ),
    );
}
