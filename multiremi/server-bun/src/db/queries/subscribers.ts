/**
 * Issue-subscriber queries — port of the Go subscriber handler's data layer
 * (server/pkg/db/queries/subscriber.sql). The issue_subscriber table has a
 * composite identity (issue_id, user_type, user_id); there is no surrogate key
 * and no workspace_id column (the issue carries the workspace).
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { issueSubscriber } from "../schema.js";

/** A single subscriber row (derived inline; schema.ts exports no named type). */
export type IssueSubscriber = typeof issueSubscriber.$inferSelect;

/**
 * All subscribers for an issue, ordered by created_at (mirrors Go
 * ListIssueSubscribers).
 */
export async function listIssueSubscribers(db: Db, issueId: string): Promise<IssueSubscriber[]> {
  return db
    .select()
    .from(issueSubscriber)
    .where(eq(issueSubscriber.issueId, issueId))
    .orderBy(asc(issueSubscriber.createdAt));
}

/**
 * Subscribe a user (member or agent) to an issue. Idempotent: a duplicate on
 * the composite primary key is ignored (mirrors Go AddIssueSubscriber's
 * ON CONFLICT DO NOTHING).
 */
export async function addIssueSubscriber(
  db: Db,
  params: { issueId: string; userType: string; userId: string; reason: string },
): Promise<void> {
  await db
    .insert(issueSubscriber)
    .values({
      issueId: params.issueId,
      userType: params.userType,
      userId: params.userId,
      reason: params.reason,
    })
    .onConflictDoNothing({
      target: [issueSubscriber.issueId, issueSubscriber.userType, issueSubscriber.userId],
    });
}

/** Remove a user's subscription from an issue (mirrors Go RemoveIssueSubscriber). */
export async function removeIssueSubscriber(
  db: Db,
  params: { issueId: string; userType: string; userId: string },
): Promise<void> {
  await db
    .delete(issueSubscriber)
    .where(
      and(
        eq(issueSubscriber.issueId, params.issueId),
        eq(issueSubscriber.userType, params.userType),
        eq(issueSubscriber.userId, params.userId),
      ),
    );
}
