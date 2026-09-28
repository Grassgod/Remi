import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentTask, Issue, IssueStatus } from "../types";
import { issueKeys } from "./queries";

/**
 * Data layer for the reviewer workbench (工作台) — the triage surface a human
 * uses to find every issue that is waiting on them or needs recovery.
 *
 * The backend keeps `issue.status = "in_review"` in sync for BOTH review
 * situations (see server tasks-repo `syncIssueStatusFromTask`):
 *  - a task finished (`completed`) → the issue parks in `in_review` until a
 *    human accepts or reopens it, and
 *  - a task is blocked on a human (`awaiting_human`, permission/question) →
 *    the issue also moves to `in_review` while the agent waits.
 *
 * The `status=in_review` list is the complete "needs me" set, and the
 * workspace agent-task snapshot (which includes every active task) splits it
 * into "answer the agent now" vs "review the finished result". A separate
 * `status=blocked` list surfaces intake work that failed before completion.
 */

/** One page is the whole workbench — matches the server's default cap. */
export const WORKBENCH_PAGE_SIZE = 200;

export const workbenchKeys = {
  /** Prefix under issueKeys.all so workspace-level invalidation reaches it. */
  all: (wsId: string) => [...issueKeys.all(wsId), "workbench"] as const,
  status: (wsId: string, status: IssueStatus) =>
    [...workbenchKeys.all(wsId), status] as const,
  /** Sidebar badge roll-up over `WORKBENCH_PENDING_STATUSES` (MUL-472 c). */
  pendingCount: (wsId: string) =>
    [...workbenchKeys.all(wsId), "pending-count"] as const,
  blocked: (wsId: string) => workbenchKeys.status(wsId, "blocked"),
};

/**
 * Flat single-status issue list (`{ issues, total }`) for one workbench
 * section. Deliberately NOT the bucketed `ListIssuesCache` shape the
 * issues/my-issues pages cache — ws-updaters patch that shape in place, so
 * this key gets plain invalidation instead (see issues/ws-updaters.ts).
 */
export function workbenchIssuesOptions(
  wsId: string,
  status: IssueStatus,
  /** MUL-472 b: `false` defers the request; a cached list still renders. */
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: workbenchKeys.status(wsId, status),
    queryFn: () => api.listIssues({ status, limit: WORKBENCH_PAGE_SIZE, offset: 0 }),
    enabled: options.enabled ?? true,
  });
}

export interface WorkbenchBuckets {
  /** The agent is blocked on a pending permission/question — answer now. */
  awaitingInput: Issue[];
  /** The agent finished; the result is waiting for human acceptance. */
  awaitingReview: Issue[];
}

/**
 * Split the `in_review` list by whether the issue currently has a task
 * blocked on a human. Order within each bucket is preserved from the input
 * (server-sorted by `updated_at DESC`).
 */
export function partitionReviewIssues(
  inReview: Issue[],
  snapshot: AgentTask[],
): WorkbenchBuckets {
  const awaitingIds = new Set<string>();
  for (const task of snapshot) {
    if (task.status === "awaiting_human" && task.issue_id) {
      awaitingIds.add(task.issue_id);
    }
  }
  const awaitingInput: Issue[] = [];
  const awaitingReview: Issue[] = [];
  for (const issue of inReview) {
    (awaitingIds.has(issue.id) ? awaitingInput : awaitingReview).push(issue);
  }
  return { awaitingInput, awaitingReview };
}

/**
 * Count of issues waiting on a human or blocked after a failed task, for the
 * sidebar badge.
 *
 * MUL-472 c: one request for both statuses (`statuses=in_review,blocked`, the
 * comma list the server already accepts) instead of two, deferred with the rest
 * of the shell. `limit` stays at 1 because the badge reads only `total`, and
 * `countIssues` ignores the limit — so the response is one row instead of the
 * two 200-row lists the old pair pulled down on every page.
 *
 * The row data stays under the per-status `workbenchKeys.status` entries: the
 * workbench page needs the buckets, this key only needs the roll-up total.
 */
export const WORKBENCH_PENDING_STATUSES: readonly IssueStatus[] = ["in_review", "blocked"];

export function workbenchPendingCountOptions(
  wsId: string,
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: workbenchKeys.pendingCount(wsId),
    queryFn: () =>
      api.listIssues({
        statuses: [...WORKBENCH_PENDING_STATUSES],
        limit: 1,
      }),
    enabled: options.enabled ?? true,
    select: (res) => res.total,
  });
}

export function useWorkbenchPendingCount(
  wsId: string | null | undefined,
  /** MUL-472 c: the badge request is part of the shell, so it waits with it. */
  enabled = true,
): number {
  const { data } = useQuery({
    ...workbenchPendingCountOptions(wsId ?? "", { enabled: enabled && !!wsId }),
  });
  return data ?? 0;
}
