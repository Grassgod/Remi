/**
 * Sub-issue completion notice — port of Go issue_child_done.go
 * notifyParentOfChildDone. When a child issue transitions INTO done, post a
 * top-level system comment on its parent so the parent's agent/squad assignee
 * sees the progress (the comment @mentions that assignee).
 *
 * Guards (mirror Go): the issue must have a parent; this must be a real
 * non-done → done transition; the parent must not already be done/cancelled;
 * and a human (member) assignee is skipped — an automated comment is noise for
 * them. The comment is inserted directly (author_type='system'), so it does NOT
 * fire the comment-@mention task trigger — it is informational.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent, comment, issue, squad } from "../db/schema.js";
import type { Issue } from "../db/schema.js";
import { getWorkspacePrefix } from "../db/queries/issues.js";
import { bus } from "../realtime/bus.js";

/** author_id for system comments — a valid all-zero UUID; gate on author_type. */
const SYSTEM_AUTHOR_ID = "00000000-0000-0000-0000-000000000000";

/** `[@Name](mention://<type>/<id>) ` for an agent/squad parent assignee, else "". */
async function buildParentAssigneeMention(db: Db, parent: Issue): Promise<string> {
  if (!parent.assigneeId || !parent.assigneeType) return "";
  if (parent.assigneeType === "agent") {
    const [a] = await db.select({ name: agent.name }).from(agent).where(eq(agent.id, parent.assigneeId));
    return a ? `[@${a.name}](mention://agent/${parent.assigneeId}) ` : "";
  }
  if (parent.assigneeType === "squad") {
    const [s] = await db.select({ name: squad.name }).from(squad).where(eq(squad.id, parent.assigneeId));
    return s ? `[@${s.name}](mention://squad/${parent.assigneeId}) ` : "";
  }
  return "";
}

/** Post the parent system comment when `updated` is a fresh child-done. */
export async function notifyParentOfChildDone(db: Db, prev: Issue, updated: Issue): Promise<void> {
  if (!updated.parentIssueId) return;
  if (prev.status === "done" || updated.status !== "done") return;

  const [parent] = await db.select().from(issue).where(eq(issue.id, updated.parentIssueId));
  if (!parent) return;
  if (parent.status === "done" || parent.status === "cancelled") return;
  // Human-assigned parents read their own timeline; skip the noise (MUL-2538).
  if (parent.assigneeType === "member") return;

  const prefix = await getWorkspacePrefix(db, updated.workspaceId);
  const identifier = prefix ? `${prefix}-${updated.number}` : `#${updated.number}`;
  const mention = await buildParentAssigneeMention(db, parent);
  const content =
    `${mention}Sub-issue [${identifier}](mention://issue/${updated.id}) — "${updated.title}" — is done. ` +
    "Before promoting any waiting `backlog` sub-issue, read each sibling's description and only promote items " +
    "whose stated dependencies are already satisfied — do not rely on this parent's higher-level breakdown alone.";

  const [c] = await db
    .insert(comment)
    .values({ issueId: parent.id, workspaceId: parent.workspaceId, authorType: "system", authorId: SYSTEM_AUTHOR_ID, content, type: "system" })
    .returning();
  if (c) bus.publish({ type: "comment.created", workspaceId: parent.workspaceId, payload: { id: c.id, issue_id: parent.id } });
}
