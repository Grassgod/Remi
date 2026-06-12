/** Attachment queries — port of the Go file handler's READ path (metadata only). */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { attachment } from "../schema.js";

/** Attachment row type (schema.ts exports no dedicated alias for this table). */
export type Attachment = typeof attachment.$inferSelect;
export type NewAttachment = typeof attachment.$inferInsert;

/** Insert an attachment metadata row (the blob lives in Storage). */
export async function createAttachment(db: Db, input: NewAttachment): Promise<Attachment> {
  const [a] = await db.insert(attachment).values(input).returning();
  return a!;
}

/**
 * List a workspace's attachments for one issue, oldest first.
 * Mirrors Go ListAttachmentsByIssue: WHERE issue_id = $1 AND workspace_id = $2
 * ORDER BY created_at ASC.
 */
export async function listAttachmentsByIssue(
  db: Db,
  wsId: string,
  issueId: string,
): Promise<Attachment[]> {
  return db
    .select()
    .from(attachment)
    .where(and(eq(attachment.issueId, issueId), eq(attachment.workspaceId, wsId)))
    .orderBy(asc(attachment.createdAt));
}

/**
 * Resolve a single attachment by UUID, scoped to the workspace (multi-tenancy).
 * Mirrors Go GetAttachment: WHERE id = $1 AND workspace_id = $2.
 * null = not found / wrong workspace.
 */
export async function getAttachment(
  db: Db,
  wsId: string,
  id: string,
): Promise<Attachment | null> {
  const [a] = await db
    .select()
    .from(attachment)
    .where(and(eq(attachment.id, id), eq(attachment.workspaceId, wsId)));
  return a ?? null;
}
