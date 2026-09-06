import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import type {
  GroupedIssuesResponse,
  Issue,
  IssueStatus,
  IssueWorkspace,
  ListGroupedIssuesParams,
  ListIssuesParams,
  ListIssuesCache,
  TimelinePage,
} from "../types";
import { BOARD_STATUSES } from "./config";

export interface IssueSortParam {
  sort_by?: ListIssuesParams["sort_by"];
  sort_direction?: ListIssuesParams["sort_direction"];
}

export const issueKeys = {
  all: (wsId: string) => ["issues", wsId] as const,
  /** PREFIX for invalidation — no sort. */
  list: (wsId: string) => [...issueKeys.all(wsId), "list"] as const,
  /** FULL KEY for queryOptions — includes sort. */
  listSorted: (wsId: string, sort?: IssueSortParam) =>
    [...issueKeys.list(wsId), sort ?? {}] as const,
  archivedAll: (wsId: string) => [...issueKeys.all(wsId), "archived"] as const,
  archivedCount: (wsId: string) => [...issueKeys.archivedAll(wsId), "count"] as const,
  archivedListAll: (wsId: string) => [...issueKeys.archivedAll(wsId), "list"] as const,
  archivedListSorted: (wsId: string, sort?: IssueSortParam) =>
    [...issueKeys.archivedListAll(wsId), sort ?? {}] as const,
  assigneeGroupsAll: (wsId: string) =>
    [...issueKeys.all(wsId), "assignee-groups"] as const,
  assigneeGroups: (wsId: string, filter: AssigneeGroupedIssuesFilter) =>
    [...issueKeys.assigneeGroupsAll(wsId), filter] as const,
  /** All "my issues" queries — use for bulk invalidation. */
  myAll: (wsId: string) => [...issueKeys.all(wsId), "my"] as const,
  /** PREFIX for per-scope invalidation — no sort. */
  myList: (wsId: string, scope: string, filter: MyIssuesFilter) =>
    [...issueKeys.myAll(wsId), scope, filter] as const,
  /** FULL KEY for queryOptions — includes sort. */
  myListSorted: (wsId: string, scope: string, filter: MyIssuesFilter, sort?: IssueSortParam) =>
    [...issueKeys.myList(wsId, scope, filter), sort ?? {}] as const,
  myAssigneeGroupsAll: (wsId: string) =>
    [...issueKeys.myAll(wsId), "assignee-groups"] as const,
  myAssigneeGroups: (
    wsId: string,
    scope: string,
    filter: AssigneeGroupedIssuesFilter,
  ) => [...issueKeys.myAssigneeGroupsAll(wsId), scope, filter] as const,
  /** All Project Gantt queries — prefix-match key for cross-project invalidation. */
  projectGanttAll: (wsId: string) =>
    [...issueKeys.all(wsId), "project-gantt"] as const,
  /**
   * Per-project Gantt issue list (scheduled-only). Uses its own cache key
   * rather than reusing the bucketed `myList` cache so WS handlers and
   * cache helpers don't have to special-case a non-bucketed shape under
   * the `my` prefix.
   */
  projectGantt: (wsId: string, projectId: string) =>
    [...issueKeys.projectGanttAll(wsId), projectId] as const,
  detail: (wsId: string, id: string) =>
    [...issueKeys.all(wsId), "detail", id] as const,
  generated: (wsId: string, id: string) =>
    [...issueKeys.all(wsId), "generated", id] as const,
  /** Prefix for every per-Issue workspace checkout, regardless of workspace. */
  workspacesAll: () => ["issues", "workspace"] as const,
  workspace: (issueId: string) =>
    [...issueKeys.workspacesAll(), issueId] as const,
  children: (wsId: string, id: string) =>
    [...issueKeys.all(wsId), "children", id] as const,
  /** Prefix for invalidating all batched-children queries in a workspace. */
  childrenByParentsAll: (wsId: string) =>
    [...issueKeys.all(wsId), "children-by-parents"] as const,
  /** Full key — includes sorted parent ids for cache stability. */
  childrenByParents: (wsId: string, parentIds: readonly string[]) =>
    [...issueKeys.childrenByParentsAll(wsId), parentIds] as const,
  childProgress: (wsId: string) =>
    [...issueKeys.all(wsId), "child-progress"] as const,
  /** Prefix for every timeline cache belonging to one Issue. */
  timelineAll: (issueId: string) =>
    ["issues", "timeline", issueId] as const,
  /** Full timeline query key, optionally scoped to one Product Session. */
  timeline: (issueId: string, issueSessionId?: string) =>
    [...issueKeys.timelineAll(issueId), issueSessionId ?? "all"] as const,
  timelinePrimer: (issueId: string) => ["issues", "timeline-primer", issueId] as const,
  timelineSyncVersion: (issueId: string) => ["issues", "timeline-sync", issueId, "version"] as const,
  timelineSyncApplied: (issueId: string, issueSessionId?: string) =>
    ["issues", "timeline-sync", issueId, issueSessionId ?? "all"] as const,
  sessions: (issueId: string) => ["issues", "sessions", issueId] as const,
  sessionTasks: (issueId: string, issueSessionId: string) =>
    ["issues", "sessions", issueId, issueSessionId, "tasks"] as const,
  sessionResults: (issueId: string) =>
    ["issues", "sessions", issueId, "results"] as const,
  reactions: (issueId: string) => ["issues", "reactions", issueId] as const,
  subscribers: (issueId: string) =>
    ["issues", "subscribers", issueId] as const,
  usage: (issueId: string) => ["issues", "usage", issueId] as const,
  /** Issue-level attachments — used by the description editor so its
   *  inline file-card / image NodeViews can re-sign download URLs at
   *  click time. */
  attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
  /** Per-issue task list (issue-detail Execution log section). */
  tasks: (issueId: string) => ["issues", "tasks", issueId] as const,
  /** Prefix-match key for invalidating tasks across all issues — used by
   *  the global WS task: prefix path so any task lifecycle event refreshes
   *  every per-issue list, regardless of which issue is currently mounted. */
  tasksAll: () => ["issues", "tasks"] as const,
};

export type MyIssuesFilter = Pick<
  ListIssuesParams,
  "assignee_id" | "assignee_ids" | "creator_id" | "project_id" | "involves_user_id"
>;

export type AssigneeGroupedIssuesFilter = Omit<
  ListGroupedIssuesParams,
  "group_by" | "limit" | "offset" | "group_assignee_type" | "group_assignee_id"
>;

/** Page size per status column. */
export const ISSUE_PAGE_SIZE = 50;

export const ARCHIVED_ISSUE_PAGE_SIZE = 50;

/** QA tuning point for the latest timeline window. */
export const ISSUE_TIMELINE_PAGE_SIZE = 40;

/** Statuses the issues/my-issues pages paginate. Cancelled is intentionally excluded — it has never been surfaced in the list/board views. */
export const PAGINATED_STATUSES: readonly IssueStatus[] = BOARD_STATUSES;

/**
 * Reconcile a per-status fan-out into buckets keyed by each issue's own
 * `status` field rather than by the status that was requested.
 *
 * The fan-out is not a consistent snapshot — it is one request per status,
 * issued in parallel — so an Issue whose status changes while it is in
 * flight comes back from two of them. Bucketing by the requested status
 * then leaves the same id in two columns, and the board's `issueMap`
 * (last write wins, in `BOARD_STATUSES` order) renders every copy using
 * the *last* bucket's row. That is how an `in_progress` Issue ends up
 * drawn under 审核中 while its detail view says 进行中.
 *
 * `total` deliberately stays the server's count for the *requested*
 * status: it is what drives `hasMore` in `useLoadMoreByStatus`, so
 * replacing it with the reconciled length would report "nothing more to
 * load" for every column and cap the board at its first page.
 */
export function reconcileIssueBuckets(
  responses: Array<{ status: IssueStatus; issues: Issue[]; total: number }>,
): ListIssuesCache {
  const byStatus: ListIssuesCache["byStatus"] = {};
  for (const status of PAGINATED_STATUSES) byStatus[status] = { issues: [], total: 0 };
  for (const response of responses) {
    const requested = byStatus[response.status];
    if (requested) requested.total = response.total;
  }
  const seen = new Set<string>();
  for (const response of responses) {
    for (const issue of response.issues) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      byStatus[issue.status]?.issues.push(issue);
    }
  }
  return { byStatus };
}

/** Flatten a bucketed response to a single Issue[] for consumers that want the whole list. */
export function flattenIssueBuckets(data: ListIssuesCache) {
  const out = [];
  for (const status of PAGINATED_STATUSES) {
    const bucket = data.byStatus[status];
    if (bucket) out.push(...bucket.issues);
  }
  return out;
}

async function fetchFirstPages(filter: MyIssuesFilter = {}, sort?: IssueSortParam): Promise<ListIssuesCache> {
  const responses = await Promise.all(
    PAGINATED_STATUSES.map((status) =>
      api.listIssues({ status, limit: ISSUE_PAGE_SIZE, offset: 0, ...sort, ...filter }),
    ),
  );
  return reconcileIssueBuckets(responses.map((res, i) => ({ ...res, status: PAGINATED_STATUSES[i]! })));
}

/**
 * "All my issues" — union of three server filters:
 *   assignee_id=me OR creator_id=me OR involves_user_id=me
 *
 * The backend has no OR-across-user-filters today, so we run the three
 * existing single-filter fetches in parallel and dedupe on the client by
 * issue id within each status bucket. Order within each bucket preserves
 * the first-seen position (each sub-fetch is already server-sorted).
 *
 * Personal lists are bounded (tens to a few hundred issues across all
 * three relations), so 3× the request count is acceptable — a single
 * fetchFirstPages already runs 7 status fetches in parallel, so the total
 * here is 21 small parallel requests. Easy enough; no need to add a new
 * backend query just for this scope.
 *
 * `total` per bucket is set to the merged length, not the true server
 * total — pagination on the "All" scope is out of scope; the first
 * 50-per-status × 3 widening (deduped) is what the page renders.
 */
async function fetchAllMyFirstPages(userId: string, sort?: IssueSortParam): Promise<ListIssuesCache> {
  const [byAssignee, byCreator, byInvolves] = await Promise.all([
    fetchFirstPages({ assignee_id: userId }, sort),
    fetchFirstPages({ creator_id: userId }, sort),
    fetchFirstPages({ involves_user_id: userId }, sort),
  ]);
  const byStatus: ListIssuesCache["byStatus"] = {};
  for (const status of PAGINATED_STATUSES) {
    const seen = new Set<string>();
    const merged: Issue[] = [];
    for (const cache of [byAssignee, byCreator, byInvolves]) {
      const bucket = cache.byStatus[status];
      if (!bucket) continue;
      for (const issue of bucket.issues) {
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        merged.push(issue);
      }
    }
    byStatus[status] = { issues: merged, total: merged.length };
  }
  return { byStatus };
}

/**
 * Sibling of {@link fetchAllMyFirstPages} for the assignee-grouped board
 * view. Runs the three single-filter grouped queries in parallel and
 * merges groups by (assignee_type, assignee_id), deduping issues within
 * each group. Extra filters from the page (statuses, priorities, etc.)
 * pass through unchanged.
 */
async function fetchAllMyAssigneeGroups(
  userId: string,
  filter: AssigneeGroupedIssuesFilter,
  sort?: IssueSortParam,
): Promise<GroupedIssuesResponse> {
  const variants: AssigneeGroupedIssuesFilter[] = [
    { ...filter, assignee_id: userId },
    { ...filter, creator_id: userId },
    { ...filter, involves_user_id: userId },
  ];
  const responses = await Promise.all(
    variants.map((f) =>
      api.listGroupedIssues({
        group_by: "assignee",
        limit: ISSUE_PAGE_SIZE,
        offset: 0,
        ...sort,
        ...f,
      }),
    ),
  );
  const groupKey = (g: GroupedIssuesResponse["groups"][number]) =>
    `${g.assignee_type ?? "_"}::${g.assignee_id ?? "_"}`;
  const merged = new Map<string, GroupedIssuesResponse["groups"][number]>();
  for (const res of responses) {
    for (const group of res.groups) {
      const key = groupKey(group);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...group,
          issues: [...group.issues],
          total: group.issues.length,
        });
        continue;
      }
      const seen = new Set(existing.issues.map((i) => i.id));
      for (const issue of group.issues) {
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        existing.issues.push(issue);
      }
      existing.total = existing.issues.length;
    }
  }
  return { groups: [...merged.values()] };
}

/**
 * CACHE SHAPE NOTE: The raw cache stores {@link ListIssuesCache} (buckets keyed
 * by status, each with `{ issues, total }`), and `select` flattens it to
 * `Issue[]` for consumers. Mutations and ws-updaters must use
 * `setQueryData<ListIssuesCache>(...)` and preserve the byStatus shape.
 *
 * Fetches the first page of each paginated status in parallel. Use
 * {@link useLoadMoreByStatus} to paginate a specific status into the cache.
 */
export function issueListOptions(wsId: string, sort?: IssueSortParam) {
  return queryOptions({
    queryKey: issueKeys.listSorted(wsId, sort),
    queryFn: () => fetchFirstPages({}, sort),
    select: flattenIssueBuckets,
    placeholderData: keepPreviousData,
  });
}

/**
 * Look up one issue in whatever list pages are ALREADY cached, without
 * subscribing to a query or triggering a fetch.
 *
 * Use this — never `useQuery(issueListOptions(wsId))` — when all you need is a
 * lookup (seeding `initialData`, resolving a title). `issueListOptions` fans
 * out to one request per board status, and because callers that only want a
 * lookup have no reason to pass a sort, their `listSorted(wsId, {})` key can
 * never hit the entry the list page wrote under `listSorted(wsId, sort)`. That
 * guaranteed miss cost ~2s per issue open on the detail page (MUL-172): six
 * status requests saturated the server before the timeline request was even
 * sent, in exchange for a seed that mostly could not fire anyway.
 *
 * Scans every sort variant of both the workspace list and "my issues", so the
 * seed hits regardless of which page the user arrived from.
 */
export function findCachedIssue(
  queryClient: QueryClient,
  wsId: string,
  id: string,
): Issue | undefined {
  const prefixes = [issueKeys.list(wsId), issueKeys.myAll(wsId)];
  for (const queryKey of prefixes) {
    for (const [, data] of queryClient.getQueriesData<ListIssuesCache>({ queryKey })) {
      // `myAll` also covers the assignee-group queries, which cache a
      // GroupedIssuesResponse rather than a bucketed list — skip those.
      if (!data?.byStatus) continue;
      // Walk the buckets directly rather than via `flattenIssueBuckets`:
      // IssueChip calls this once per render per mention, so avoid building a
      // throwaway array of every cached issue on each of them.
      for (const status of PAGINATED_STATUSES) {
        const hit = data.byStatus[status]?.issues.find((issue) => issue.id === id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

export function archivedIssueCountOptions(wsId: string) {
  return queryOptions({
    queryKey: issueKeys.archivedCount(wsId),
    queryFn: async () => (await api.listIssues({ archived_only: true, limit: 1, offset: 0 })).total,
  });
}

export function archivedIssueListOptions(wsId: string, sort?: IssueSortParam) {
  return queryOptions({
    queryKey: issueKeys.archivedListSorted(wsId, sort),
    queryFn: () => api.listIssues({
      archived_only: true,
      limit: ARCHIVED_ISSUE_PAGE_SIZE,
      offset: 0,
      ...sort,
    }),
    placeholderData: keepPreviousData,
  });
}

export function issueAssigneeGroupsOptions(
  wsId: string,
  filter: AssigneeGroupedIssuesFilter,
  sort?: IssueSortParam,
) {
  return queryOptions<GroupedIssuesResponse>({
    queryKey: issueKeys.assigneeGroups(wsId, { ...filter, ...sort }),
    queryFn: () =>
      api.listGroupedIssues({
        group_by: "assignee",
        limit: ISSUE_PAGE_SIZE,
        offset: 0,
        ...sort,
        ...filter,
      }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Server-filtered issue list for the My Issues page.
 * Each scope gets its own cache entry so switching tabs is instant after first load.
 */
export function myIssueListOptions(
  wsId: string,
  scope: string,
  filter: MyIssuesFilter,
  // Required when scope === "all" — the user id whose three relations
  // (assignee, creator, agents+squads) we union over. For every other
  // scope the filter object already carries the relevant id and userId
  // is ignored.
  userId?: string,
  sort?: IssueSortParam,
) {
  return queryOptions({
    queryKey: issueKeys.myListSorted(wsId, scope, filter, sort),
    queryFn: () =>
      scope === "all" && userId
        ? fetchAllMyFirstPages(userId, sort)
        : fetchFirstPages(filter, sort),
    select: flattenIssueBuckets,
    placeholderData: keepPreviousData,
  });
}

/**
 * Page size for the scheduled-issue fetch. The Gantt view always pulls every
 * scheduled issue (no client pagination), so this is just the chunk size we
 * use to walk the server's `(limit, offset)` window until we hit `total`.
 */
export const PROJECT_GANTT_PAGE_LIMIT = 500;

/**
 * Paranoia cap on the loop in {@link fetchProjectGanttIssues}. Real projects
 * shouldn't come close to this — a single project carrying 50k scheduled
 * issues is already a product problem, not a Gantt-rendering one — but the
 * guard prevents a buggy server `total` from spinning the loop forever.
 */
export const PROJECT_GANTT_MAX_ISSUES = 10_000;

async function fetchProjectGanttIssues(projectId: string) {
  const issues = [];
  let offset = 0;
  while (offset < PROJECT_GANTT_MAX_ISSUES) {
    const res = await api.listIssues({
      project_id: projectId,
      scheduled: true,
      limit: PROJECT_GANTT_PAGE_LIMIT,
      offset,
    });
    issues.push(...res.issues);
    if (res.issues.length < PROJECT_GANTT_PAGE_LIMIT) break;
    if (issues.length >= res.total) break;
    offset += PROJECT_GANTT_PAGE_LIMIT;
  }
  return issues;
}

/**
 * One-shot fetch of every scheduled issue (`start_date` or `due_date` set)
 * for a project. The Project Gantt view consumes this directly — no status
 * bucketing, no client-side pagination, no Load-all affordance — because
 * the scheduled subset is bounded enough to come back in a small handful of
 * requests.
 *
 * Backed by `GET /api/issues?scheduled=true&project_id=…`; the SQL filter
 * mirrors the same `(start_date IS NOT NULL OR due_date IS NOT NULL)`
 * predicate the Gantt view applies on the client. Pages are walked until
 * `total` is reached so an oversized project can't silently lose bars past
 * the first page.
 */
export function projectGanttIssuesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: issueKeys.projectGantt(wsId, projectId),
    queryFn: () => fetchProjectGanttIssues(projectId),
  });
}

export function myIssueAssigneeGroupsOptions(
  wsId: string,
  scope: string,
  filter: AssigneeGroupedIssuesFilter,
  // See myIssueListOptions for the userId contract — only consulted when
  // scope === "all", and powers the 3-fetch grouped union.
  userId?: string,
  sort?: IssueSortParam,
) {
  return queryOptions<GroupedIssuesResponse>({
    queryKey: issueKeys.myAssigneeGroups(wsId, scope, { ...filter, ...sort }),
    queryFn: () =>
      scope === "all" && userId
        ? fetchAllMyAssigneeGroups(userId, filter, sort)
        : api.listGroupedIssues({
            group_by: "assignee",
            limit: ISSUE_PAGE_SIZE,
            offset: 0,
            ...sort,
            ...filter,
          }),
    placeholderData: keepPreviousData,
  });
}

export function issueDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: issueKeys.detail(wsId, id),
    queryFn: () => api.getIssue(id),
  });
}

export function generatedIssuesOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: issueKeys.generated(wsId, id),
    queryFn: () => api.listGeneratedIssues(id),
  });
}

export function issueWorkspaceOptions(issueId: string) {
  return queryOptions<IssueWorkspace | null>({
    queryKey: issueKeys.workspace(issueId),
    queryFn: async () => (await api.getIssueWorkspace(issueId)).workspace,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "preparing" || status === "in_use" ? 5_000 : 30_000;
    },
  });
}

export function childIssueProgressOptions(wsId: string) {
  return queryOptions({
    queryKey: issueKeys.childProgress(wsId),
    queryFn: () => api.getChildIssueProgress(),
    select: (data) => {
      const map = new Map<string, { done: number; total: number }>();
      for (const entry of data.progress) {
        map.set(entry.parent_issue_id, { done: entry.done, total: entry.total });
      }
      return map;
    },
  });
}

export function childIssuesOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: issueKeys.children(wsId, id),
    queryFn: () => api.listChildIssues(id).then((r) => r.issues),
  });
}

/**
 * Server cap on parent_ids per `GET /api/issues/children` request — must
 * match `listChildrenByParentsLimit` in server/internal/handler/issue.go.
 * Exceeding it returns 400, so the client chunks larger requests.
 */
export const CHILDREN_BY_PARENTS_CHUNK_SIZE = 200;

/**
 * Batched variant of {@link childIssuesOptions}: fetches children for all
 * given parents in `GET /api/issues/children?parent_ids=…` requests, chunked
 * to {@link CHILDREN_BY_PARENTS_CHUNK_SIZE} parents each. The queryFn also
 * hydrates each parent's per-parent issueKeys.children cache so other
 * surfaces (issue-detail sub-issues panel, set-parent modal) hit the primed
 * cache instead of re-fetching. Hydration happens in queryFn (not a
 * useEffect) to avoid the setQueryData → re-render → effect loop.
 *
 * Used by SwimLaneView to resolve parent lanes without an N-request fan-out.
 * parentIds must be sorted + deduplicated by the caller for a stable cache key.
 */
async function fetchAndHydrateChildrenByParents(
  qc: QueryClient,
  wsId: string,
  parentIds: readonly string[],
) {
  // Chunk to respect the server cap (parallel, since chunks are independent).
  const chunks: string[][] = [];
  for (let i = 0; i < parentIds.length; i += CHILDREN_BY_PARENTS_CHUNK_SIZE) {
    chunks.push([...parentIds.slice(i, i + CHILDREN_BY_PARENTS_CHUNK_SIZE)]);
  }
  const responses = await Promise.all(chunks.map((c) => api.listChildrenByParents(c)));
  const grouped = new Map<string, Issue[]>();
  for (const response of responses) {
    for (const issue of response.issues) {
      if (!issue.parent_issue_id) continue;
      const bucket = grouped.get(issue.parent_issue_id);
      if (bucket) {
        bucket.push(issue);
      } else {
        grouped.set(issue.parent_issue_id, [issue]);
      }
    }
  }
  for (const [parentId, children] of grouped) {
    // Only hydrate if the per-parent cache is empty — don't overwrite a
    // fresher result that another query (e.g. issue-detail) may have written.
    // This relies on useUpdateIssue.onMutate writing into the per-parent
    // cache (not creating an empty one) — if that contract changes, batch
    // hydration here would silently stop seeding new lanes.
    const existing = qc.getQueryData<Issue[]>(issueKeys.children(wsId, parentId));
    if (!existing || existing.length === 0) {
      qc.setQueryData(issueKeys.children(wsId, parentId), children);
    }
  }
  return grouped;
}

export function childrenByParentsOptions(
  wsId: string,
  parentIds: readonly string[],
  qc: QueryClient,
) {
  return queryOptions({
    queryKey: issueKeys.childrenByParents(wsId, parentIds),
    queryFn: () => fetchAndHydrateChildrenByParents(qc, wsId, parentIds),
    enabled: parentIds.length > 0,
  });
}

/** Page zero is the latest chronological window; subsequent pages are older. */
export function issueTimelinePageOptions(issueId: string, issueSessionId?: string) {
  return infiniteQueryOptions<
    TimelinePage,
    Error,
    InfiniteData<TimelinePage, string | null>,
    ReturnType<typeof issueKeys.timeline>,
    string | null
  >({
    queryKey: issueKeys.timeline(issueId, issueSessionId),
    queryFn: ({ pageParam }) => api.listTimelinePage(issueId, {
      issueSessionId,
      before: pageParam,
      limit: ISSUE_TIMELINE_PAGE_SIZE,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.next_cursor ?? undefined : undefined,
    staleTime: Infinity,
  });
}

export function issueTimelinePrimerOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.timelinePrimer(issueId),
    queryFn: () => api.listTimelinePage(issueId, {
      issueSessionId: "@default",
      limit: ISSUE_TIMELINE_PAGE_SIZE,
    }),
    staleTime: 0,
  });
}

export function issueSessionsOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.sessions(issueId),
    queryFn: () => api.listIssueSessions(issueId),
  });
}

export function issueSessionTasksOptions(issueId: string, issueSessionId: string) {
  return queryOptions({
    queryKey: issueKeys.sessionTasks(issueId, issueSessionId),
    queryFn: () => api.listSessionTasks(issueId, issueSessionId),
    enabled: Boolean(issueId && issueSessionId),
  });
}

export function issueSessionResultsOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.sessionResults(issueId),
    queryFn: () => api.listIssueSessionResults(issueId),
  });
}

export function issueReactionsOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.reactions(issueId),
    queryFn: async () => {
      const issue = await api.getIssue(issueId);
      return issue.reactions ?? [];
    },
  });
}

export function issueSubscribersOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.subscribers(issueId),
    queryFn: () => api.listIssueSubscribers(issueId),
  });
}

export function issueUsageOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.usage(issueId),
    queryFn: () => api.getIssueUsage(issueId),
  });
}

// Backs the description editor's fresh-sign download flow: NodeViews resolve
// an attachment id by matching the markdown URL against this list. The list
// is workspace-private metadata and lives on the same cache lifetime as the
// rest of the issue detail surface.
export function issueAttachmentsOptions(issueId: string) {
  return queryOptions({
    queryKey: issueKeys.attachments(issueId),
    queryFn: () => api.listAttachments(issueId),
  });
}
