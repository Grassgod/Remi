/**
 * Comment queries — port of the Go comment handler's read path (list + create).
 *
 * Scope: the default chronological list for an issue and the create path. The
 * Go handler's thread/recent/roots_only/cursor read modes and the
 * reaction/attachment subsystems are out of scope for this chunk, so the list
 * returns the full chronological dump capped at the same hard cap, and create
 * returns an empty reactions/attachments set (matching the Go default shape).
 */

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agent, comment, member, type Comment, type Member } from "../schema.js";

/** A root comment annotated with thread stats (the roots_only list mode). */
export type RootCommentRow = Comment & { replyCount: number; lastActivityAt: string };

/** Insert row type for the comment table (not exported from schema). */
type NewComment = typeof comment.$inferInsert;
/** Agent row type (not exported from schema). */
type Agent = typeof agent.$inferSelect;

/**
 * commentHardCap bounds the comments returned per issue. Mirrors the Go
 * constant: a defensive ceiling, not a UX paging window.
 */
export const commentHardCap = 2000;

/** Membership gate (mirrors Go GetMemberByUserAndWorkspace). null = not a member. */
export async function getMembership(db: Db, userId: string, wsId: string): Promise<Member | null> {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, wsId)));
  return m ?? null;
}

/**
 * Full chronological comment list for an issue, workspace-scoped (multi-tenancy),
 * oldest → newest, capped at commentHardCap. Mirrors Go ListCommentsForIssue.
 */
export async function listCommentsForIssue(
  db: Db,
  issueId: string,
  wsId: string,
): Promise<Comment[]> {
  return db
    .select()
    .from(comment)
    .where(and(eq(comment.issueId, issueId), eq(comment.workspaceId, wsId)))
    .orderBy(asc(comment.createdAt), asc(comment.id))
    .limit(commentHardCap);
}

/**
 * Incremental list mode (?since=<RFC3339>): comments created strictly after
 * `since`, chronological, capped. Mirrors Go's --since polling path — agents
 * use it to fetch only replies they haven't seen.
 */
export async function listCommentsForIssueSince(
  db: Db,
  issueId: string,
  wsId: string,
  since: Date,
): Promise<Comment[]> {
  return db
    .select()
    .from(comment)
    .where(and(eq(comment.issueId, issueId), eq(comment.workspaceId, wsId), gt(comment.createdAt, since.toISOString())))
    .orderBy(asc(comment.createdAt), asc(comment.id))
    .limit(commentHardCap);
}

/**
 * roots_only list mode: top-level comments (parent_id IS NULL) for an issue,
 * each annotated with reply_count (descendants across the whole thread subtree)
 * and last_activity_at (MAX(created_at) over the subtree). Mirrors Go's
 * roots_only path. The recursive CTE walks parent_id links so arbitrarily
 * nested replies are counted, then aggregates per root.
 */
export async function listRootCommentsWithStats(
  db: Db,
  issueId: string,
  wsId: string,
): Promise<RootCommentRow[]> {
  const roots = await db
    .select()
    .from(comment)
    .where(and(eq(comment.issueId, issueId), eq(comment.workspaceId, wsId), isNull(comment.parentId)))
    .orderBy(asc(comment.createdAt), asc(comment.id))
    .limit(commentHardCap);
  if (roots.length === 0) return [];

  // Per-root subtree stats: count of descendants + max created_at over subtree.
  const stats = await db.execute<{ root_id: string; reply_count: number; last_activity_at: string }>(sql`
    WITH RECURSIVE thread AS (
      SELECT id, created_at, id AS root_id
      FROM comment
      WHERE issue_id = ${issueId} AND parent_id IS NULL
      UNION ALL
      SELECT c.id, c.created_at, t.root_id
      FROM comment c JOIN thread t ON c.parent_id = t.id
    )
    SELECT root_id,
           (count(*) - 1)::int AS reply_count,
           max(created_at) AS last_activity_at
    FROM thread
    GROUP BY root_id
  `);
  const byRoot = new Map<string, { replyCount: number; lastActivityAt: string }>();
  for (const row of stats as unknown as { root_id: string; reply_count: number; last_activity_at: string }[]) {
    byRoot.set(row.root_id, { replyCount: Number(row.reply_count), lastActivityAt: row.last_activity_at as string });
  }

  return roots.map((r) => {
    const s = byRoot.get(r.id);
    return { ...r, replyCount: s?.replyCount ?? 0, lastActivityAt: s?.lastActivityAt ?? r.createdAt };
  });
}

/** Fetch a single comment by id (used to validate a parent_id reference). */
export async function getComment(db: Db, id: string): Promise<Comment | null> {
  const [c] = await db.select().from(comment).where(eq(comment.id, id));
  return c ?? null;
}

/** Look up an agent by id (used by actor resolution for the X-Agent-ID path). */
export async function getAgent(db: Db, id: string): Promise<Agent | null> {
  const [a] = await db.select().from(agent).where(eq(agent.id, id));
  return a ?? null;
}

export async function createComment(db: Db, input: NewComment): Promise<Comment> {
  const [c] = await db.insert(comment).values(input).returning();
  return c!;
}
