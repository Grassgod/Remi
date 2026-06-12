/** Issue queries — port of the Go issue handler's read path (list + get). */

import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { issue, member, workspace, type Issue, type NewIssue, type Member } from "../schema.js";

/** Filters the list endpoint accepts (mirrors the Go ListIssues query params). */
export interface IssueListFilters {
  status?: string;
  priority?: string;
  assigneeId?: string;
  projectId?: string;
  creatorId?: string;
  openOnly?: boolean;
  limit?: number;
  offset?: number;
  sort?: string;
  direction?: "asc" | "desc";
}

const SORT_COLUMNS = {
  position: issue.position,
  priority: issue.priority,
  title: issue.title,
  created_at: issue.createdAt,
  start_date: issue.startDate,
  due_date: issue.dueDate,
  updated_at: issue.updatedAt,
} as const;

/** Per-parent sub-issue done/total counts (the parent cards' progress bars). */
export async function childIssueProgress(
  db: Db,
  wsId: string,
  parentIds: string[],
): Promise<{ parent_issue_id: string; total: number; done: number }[]> {
  if (parentIds.length === 0) return [];
  const rows = await db
    .select({
      parentId: issue.parentIssueId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${issue.status} = 'done')::int`,
    })
    .from(issue)
    .where(and(eq(issue.workspaceId, wsId), inArray(issue.parentIssueId, parentIds)))
    .groupBy(issue.parentIssueId);
  return rows.map((r) => ({ parent_issue_id: r.parentId as string, total: Number(r.total), done: Number(r.done) }));
}

/** Filtered + paginated issue list with a total count (the board's columns). */
export async function listIssuesFiltered(
  db: Db,
  wsId: string,
  f: IssueListFilters,
): Promise<{ issues: Issue[]; total: number }> {
  const conds = [eq(issue.workspaceId, wsId)];
  if (f.status) conds.push(eq(issue.status, f.status));
  if (f.priority) conds.push(eq(issue.priority, f.priority));
  if (f.assigneeId) conds.push(eq(issue.assigneeId, f.assigneeId));
  if (f.projectId) conds.push(eq(issue.projectId, f.projectId));
  if (f.creatorId) conds.push(eq(issue.creatorId, f.creatorId));
  if (f.openOnly) conds.push(notInArray(issue.status, ["done", "cancelled"]));
  const where = and(...conds);

  const col = SORT_COLUMNS[(f.sort ?? "position") as keyof typeof SORT_COLUMNS] ?? issue.position;
  const dir = f.direction === "desc" ? desc : asc;
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  const [rows, totalRows] = await Promise.all([
    db.select().from(issue).where(where).orderBy(dir(col), asc(issue.id)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(issue).where(where),
  ]);
  return { issues: rows, total: Number(totalRows[0]?.n ?? 0) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Membership gate (mirrors Go GetMemberByUserAndWorkspace). null = not a member. */
export async function getMembership(db: Db, userId: string, wsId: string): Promise<Member | null> {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, wsId)));
  return m ?? null;
}

/** The workspace's issue identifier prefix (e.g. "MUL"), for "MUL-123". */
export async function getWorkspacePrefix(db: Db, wsId: string): Promise<string> {
  const [w] = await db.select({ p: workspace.issuePrefix }).from(workspace).where(eq(workspace.id, wsId));
  return w?.p ?? "";
}

/**
 * Atomically allocate the next per-workspace issue number. The single
 * UPDATE ... RETURNING is race-safe (mirrors Go's IncrementIssueCounter), so
 * concurrent creates never collide on a number.
 */
export async function nextIssueNumber(db: Db, wsId: string): Promise<number> {
  const [row] = await db
    .update(workspace)
    .set({ issueCounter: sql`${workspace.issueCounter} + 1` })
    .where(eq(workspace.id, wsId))
    .returning({ n: workspace.issueCounter });
  return row?.n ?? 0;
}

export async function createIssue(db: Db, input: NewIssue): Promise<Issue> {
  const [i] = await db.insert(issue).values(input).returning();
  return i!;
}

/** Partial update by primary key (caller resolves + authorizes the id first). */
export async function updateIssue(
  db: Db,
  id: string,
  fields: Partial<NewIssue>,
): Promise<Issue | null> {
  const [i] = await db
    .update(issue)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(issue.id, id))
    .returning();
  return i ?? null;
}

export async function deleteIssue(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(issue).where(eq(issue.id, id)).returning({ id: issue.id });
  return res.length > 0;
}

export async function listIssues(db: Db, wsId: string): Promise<Issue[]> {
  return db
    .select()
    .from(issue)
    .where(eq(issue.workspaceId, wsId))
    .orderBy(desc(issue.updatedAt));
}

/**
 * Resolve an issue by a UUID or a human identifier ("MUL-123" or a bare "123"),
 * always scoped to the workspace (multi-tenancy). Mirrors the Go loader.
 */
export async function getIssueByIdentifier(
  db: Db,
  wsId: string,
  idOrNumber: string,
): Promise<Issue | null> {
  const num = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(idOrNumber.trim());
  if (num) {
    const n = Number.parseInt(num[1]!, 10);
    const [i] = await db
      .select()
      .from(issue)
      .where(and(eq(issue.workspaceId, wsId), eq(issue.number, n)));
    return i ?? null;
  }
  if (UUID_RE.test(idOrNumber)) {
    const [i] = await db
      .select()
      .from(issue)
      .where(and(eq(issue.workspaceId, wsId), eq(issue.id, idOrNumber)));
    return i ?? null;
  }
  return null;
}
