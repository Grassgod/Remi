/**
 * Search queries — read path port of the Go SearchIssues handler
 * (server/internal/handler/issue.go, mounted at GET /api/issues/search).
 *
 * SIMPLIFICATION: the Go handler runs a dynamic full-text query over title +
 * description + comment content with multi-tier ranking (pg_bigm GIN, LOWER()
 * LIKE), per-term AND matching, match_source classification, and snippet
 * extraction. Per the task brief, this port keeps it to a basic case-insensitive
 * title/identifier match: title ILIKE '%q%' OR issue number = <n> when the query
 * looks like "MUL-123" / "123". Description, comment, ranking tiers, and snippets
 * are intentionally dropped. The one behaviour we preserve from Go is excluding
 * terminal issues (status IN ('done','cancelled')) unless include_closed=true,
 * and ordering by updated_at DESC.
 */

import { and, desc, eq, ilike, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.js";
import { issue, type Issue } from "../schema.js";

const TERMINAL_STATUSES = ["done", "cancelled"];

/** Escape LIKE wildcards so a literal % or _ in the query matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Parse a trailing issue number out of the query: "MUL-123", "mul-123", or a
 * bare "123" all yield 123 (mirrors the Go parseQueryNumber helper). Anything
 * else (no number, or 0) yields null.
 */
function parseQueryNumber(q: string): number | null {
  const m = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(q.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface SearchIssuesResult {
  issues: Issue[];
  total: number;
}

/**
 * Basic workspace-scoped issue search: title ILIKE the query, OR exact issue
 * number when the query parses as an identifier. Excludes terminal issues
 * unless includeClosed is set. Ordered by updated_at DESC, then paginated.
 */
export async function searchIssues(
  db: Db,
  wsId: string,
  q: string,
  opts: { includeClosed?: boolean; limit?: number; offset?: number } = {},
): Promise<SearchIssuesResult> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const matches: SQL[] = [ilike(issue.title, `%${escapeLike(q)}%`)];
  const num = parseQueryNumber(q);
  if (num !== null) matches.push(eq(issue.number, num));

  const conds: SQL[] = [eq(issue.workspaceId, wsId), or(...matches)!];
  if (!opts.includeClosed) conds.push(notInArray(issue.status, TERMINAL_STATUSES));
  const where = and(...conds);

  const rows = await db
    .select({ issue, total: sql<number>`count(*) OVER()::int` })
    .from(issue)
    .where(where)
    .orderBy(desc(issue.updatedAt))
    .limit(limit)
    .offset(offset);

  return {
    issues: rows.map((r) => r.issue),
    total: rows.length > 0 ? rows[0]!.total : 0,
  };
}
