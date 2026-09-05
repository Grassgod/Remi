import type {
  Issue,
  IssueStatus,
  IssueStatusBucket,
  ListIssuesCache,
} from "../types";
import { PAGINATED_STATUSES } from "./queries";

const EMPTY_BUCKET: IssueStatusBucket = { issues: [], total: 0 };

export function getBucket(
  resp: ListIssuesCache,
  status: IssueStatus,
): IssueStatusBucket {
  return resp.byStatus[status] ?? EMPTY_BUCKET;
}

export function setBucket(
  resp: ListIssuesCache,
  status: IssueStatus,
  bucket: IssueStatusBucket,
): ListIssuesCache {
  return { ...resp, byStatus: { ...resp.byStatus, [status]: bucket } };
}

/** Locate which status bucket holds `id`, if any. */
export function findIssueLocations(
  resp: ListIssuesCache,
  id: string,
): Array<{ status: IssueStatus; issue: Issue }> {
  const locations: Array<{ status: IssueStatus; issue: Issue }> = [];
  for (const status of PAGINATED_STATUSES) {
    const bucket = resp.byStatus[status];
    const found = bucket?.issues.find((i) => i.id === id);
    if (found) locations.push({ status, issue: found });
  }
  return locations;
}

export function findIssueLocation(resp: ListIssuesCache, id: string) {
  return findIssueLocations(resp, id)[0] ?? null;
}

/** Add an issue to its status bucket (no-op if already present). */
export function addIssueToBuckets(
  resp: ListIssuesCache,
  issue: Issue,
): ListIssuesCache {
  const bucket = getBucket(resp, issue.status);
  if (bucket.issues.some((i) => i.id === issue.id)) return resp;
  return setBucket(resp, issue.status, {
    issues: [...bucket.issues, issue],
    total: bucket.total + 1,
  });
}

/** Remove an issue from whichever bucket contains it. */
export function removeIssueFromBuckets(
  resp: ListIssuesCache,
  id: string,
): ListIssuesCache {
  let next = resp;
  for (const loc of findIssueLocations(resp, id)) {
    const bucket = getBucket(next, loc.status);
    next = setBucket(next, loc.status, {
      issues: bucket.issues.filter((i) => i.id !== id),
      total: Math.max(0, bucket.total - 1),
    });
  }
  return next;
}

/**
 * Append a freshly loaded page of `status` onto that status bucket.
 *
 * The server has just asserted that every returned id belongs to `status`,
 * so any copy sitting in a *different* bucket is stale — it was captured by
 * an earlier fan-out before the issue changed status. Evict those first;
 * appending blindly would leave the id in two columns, and the board's
 * `issueMap` would then render the card under whichever bucket comes last
 * in `BOARD_STATUSES`.
 *
 * `total` is taken from the response because it is the server's count for
 * `status` and is what `hasMore` compares `issues.length` against.
 */
export function appendLoadedPage(
  resp: ListIssuesCache,
  status: IssueStatus,
  page: { issues: Issue[]; total: number },
): ListIssuesCache {
  let next = resp;
  const alreadyInBucket = new Set(getBucket(resp, status).issues.map((i) => i.id));
  for (const issue of page.issues) {
    if (alreadyInBucket.has(issue.id)) continue;
    next = removeIssueFromBuckets(next, issue.id);
  }
  const prev = getBucket(next, status);
  const existingIds = new Set(prev.issues.map((i) => i.id));
  return setBucket(next, status, {
    issues: [...prev.issues, ...page.issues.filter((i) => !existingIds.has(i.id))],
    total: page.total,
  });
}

/**
 * Merge `patch` into the issue with `id`. If `patch.status` differs from the
 * current bucket, the issue moves to the new bucket and both buckets' totals
 * are adjusted.
 *
 * Stale duplicates left in other buckets by a mid-flight fan-out are also
 * collapsed, so a WS patch converges the cache onto a single copy instead
 * of only ever repairing the first one it finds.
 */
export function patchIssueInBuckets(
  resp: ListIssuesCache,
  id: string,
  patch: Partial<Issue>,
): ListIssuesCache {
  const locations = findIssueLocations(resp, id);
  if (locations.length === 0) return resp;
  const nextStatus = patch.status ?? locations[0]!.status;
  // Merge onto the copy that already lives in the destination bucket when
  // there is one — with duplicates present that is the fresher row.
  const base = locations.find((l) => l.status === nextStatus) ?? locations[0]!;
  const merged: Issue = { ...base.issue, ...patch };

  // Fast path: single copy, staying put. Replace in place so the card keeps
  // its position — rebuilding the bucket would make every WS update kick the
  // card to the bottom of its column.
  if (locations.length === 1 && locations[0]!.status === nextStatus) {
    const bucket = getBucket(resp, nextStatus);
    return setBucket(resp, nextStatus, {
      ...bucket,
      issues: bucket.issues.map((i) => (i.id === id ? merged : i)),
    });
  }

  // Slow path: the issue is moving buckets and/or duplicated across them.
  // Drop every stale copy, then land it in the destination bucket — reusing
  // its existing slot there if it already had one.
  let next = resp;
  for (const loc of locations) {
    if (loc.status === nextStatus) continue;
    const bucket = getBucket(next, loc.status);
    next = setBucket(next, loc.status, {
      issues: bucket.issues.filter((i) => i.id !== id),
      total: Math.max(0, bucket.total - 1),
    });
  }
  const toBucket = getBucket(next, nextStatus);
  const alreadyThere = toBucket.issues.some((i) => i.id === id);
  return setBucket(next, nextStatus, {
    issues: alreadyThere
      ? toBucket.issues.map((i) => (i.id === id ? merged : i))
      : [...toBucket.issues, merged],
    total: alreadyThere ? toBucket.total : toBucket.total + 1,
  });
}
