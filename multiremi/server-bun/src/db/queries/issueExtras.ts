/**
 * Issue-extras queries — child issues plus the issue↔label join (port of the
 * Go ListChildIssues query in issue.sql and the attach/detach/list queries in
 * issue_label.sql). The per-issue attachment list already lives in
 * queries/attachments.ts (listAttachmentsByIssue) and is reused by the route.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { issue, issueLabel, issueToLabel, type Issue } from "../schema.js";
import type { Label } from "./labels.js";

/**
 * Child issues of a parent (Go ListChildIssues):
 * WHERE parent_issue_id = $1 ORDER BY position ASC, created_at DESC.
 * No workspace filter — the caller authorizes via the parent issue, and a
 * child always shares its parent's workspace.
 */
export async function listChildIssues(db: Db, parentIssueId: string): Promise<Issue[]> {
  return db
    .select()
    .from(issue)
    .where(eq(issue.parentIssueId, parentIssueId))
    .orderBy(asc(issue.position), desc(issue.createdAt));
}

/**
 * Labels attached to an issue, ordered by LOWER(name) ASC. Workspace filter at
 * the SQL layer (mirrors Go ListLabelsByIssue): a caller passing the wrong
 * workspace gets an empty list rather than leaking labels.
 */
export async function listLabelsByIssue(db: Db, wsId: string, issueId: string): Promise<Label[]> {
  return db
    .select({
      id: issueLabel.id,
      workspaceId: issueLabel.workspaceId,
      name: issueLabel.name,
      color: issueLabel.color,
      createdAt: issueLabel.createdAt,
      updatedAt: issueLabel.updatedAt,
    })
    .from(issueLabel)
    .innerJoin(issueToLabel, eq(issueToLabel.labelId, issueLabel.id))
    .where(and(eq(issueToLabel.issueId, issueId), eq(issueLabel.workspaceId, wsId)))
    .orderBy(asc(sql`lower(${issueLabel.name})`));
}

/**
 * Attach a label to an issue (Go AttachLabelToIssue). Idempotent — the
 * (issue_id, label_id) pair is the primary key, so re-attaching is
 * ON CONFLICT DO NOTHING. The route prechecks that both the issue and the
 * label belong to the caller's workspace (mirroring the Go handler), so the
 * row can never cross a workspace boundary.
 */
export async function attachLabelToIssue(db: Db, issueId: string, labelId: string): Promise<void> {
  await db.insert(issueToLabel).values({ issueId, labelId }).onConflictDoNothing();
}

/** Detach a label from an issue (Go DetachLabelFromIssue). No-op if absent. */
export async function detachLabelFromIssue(
  db: Db,
  issueId: string,
  labelId: string,
): Promise<void> {
  await db
    .delete(issueToLabel)
    .where(and(eq(issueToLabel.issueId, issueId), eq(issueToLabel.labelId, labelId)));
}
