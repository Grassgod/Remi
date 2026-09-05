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
 * Merge `patch` into the issue with `id`. If `patch.status` differs from the
 * current bucket, the issue moves to the new bucket and both buckets' totals
 * are adjusted.
 */
export function patchIssueInBuckets(
  resp: ListIssuesCache,
  id: string,
  patch: Partial<Issue>,
): ListIssuesCache {
  const loc = findIssueLocations(resp, id)[0];
  if (!loc) return resp;
  const merged: Issue = { ...loc.issue, ...patch };
  const nextStatus = patch.status ?? loc.status;
  let next = removeIssueFromBuckets(resp, id);
  const toBucket = getBucket(next, nextStatus);
  next = setBucket(next, nextStatus, {
    issues: [...toBucket.issues, merged],
    total: toBucket.total + 1,
  });
  return next;
}
