/** Label queries — port of the Go issue-label handler's read path (list + create). */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { issueLabel } from "../schema.js";

/** issue_label has no exported $inferSelect type in schema.ts — declare it locally. */
export type Label = typeof issueLabel.$inferSelect;
export type NewLabel = typeof issueLabel.$inferInsert;

/**
 * List a workspace's labels, ordered by LOWER(name) ASC (mirrors the Go
 * ListLabels query). Workspace-scoped for multi-tenancy.
 */
export async function listLabels(db: Db, wsId: string): Promise<Label[]> {
  return db
    .select()
    .from(issueLabel)
    .where(eq(issueLabel.workspaceId, wsId))
    .orderBy(asc(sql`lower(${issueLabel.name})`));
}

/**
 * Resolve a single label by id within a workspace (mirrors the Go GetLabel
 * query: WHERE id = $1 AND workspace_id = $2). null = not found / not in ws.
 */
export async function getLabel(db: Db, wsId: string, id: string): Promise<Label | null> {
  const [l] = await db
    .select()
    .from(issueLabel)
    .where(and(eq(issueLabel.id, id), eq(issueLabel.workspaceId, wsId)));
  return l ?? null;
}

/** Insert a label (mirrors the Go CreateLabel query: RETURNING *). */
export async function createLabel(db: Db, input: NewLabel): Promise<Label> {
  const [l] = await db.insert(issueLabel).values(input).returning();
  return l!;
}
