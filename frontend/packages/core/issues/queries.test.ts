import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { Issue, ListIssuesParams, ListIssuesResponse, TimelinePage } from "../types";
import {
  CHILDREN_BY_PARENTS_CHUNK_SIZE,
  ISSUE_TIMELINE_PAGE_SIZE,
  archivedIssueCountOptions,
  archivedIssueListOptions,
  PROJECT_GANTT_MAX_ISSUES,
  PROJECT_GANTT_PAGE_LIMIT,
  childrenByParentsOptions,
  findCachedIssue,
  issueKeys,
  issueTimelinePageOptions,
  issueTimelinePrimerOptions,
  projectGanttIssuesOptions,
} from "./queries";

const WS_ID = "ws-1";
const PROJECT_ID = "project-1";

describe("issue timeline query options", () => {
  const page = (hasMore: boolean): TimelinePage => ({
    entries: [],
    limit: ISSUE_TIMELINE_PAGE_SIZE,
    has_more: hasMore,
    has_more_before: hasMore,
    has_more_after: false,
    next_cursor: hasMore ? "older-cursor" : null,
    prev_cursor: null,
    issue_session_id: "session-main",
  });

  it("uses page zero as latest and advances only through before cursors", async () => {
    const listTimelinePage = vi.fn().mockResolvedValue(page(true));
    setApiInstance({ listTimelinePage } as unknown as ApiClient);
    const options = issueTimelinePageOptions("issue-1", "session-main");

    expect(options.initialPageParam).toBeNull();
    expect(options.staleTime).toBe(Infinity);
    expect(options.getNextPageParam?.(page(true), [page(true)], null, [null])).toBe("older-cursor");
    expect(options.getNextPageParam?.(page(false), [page(false)], null, [null])).toBeUndefined();

    await options.queryFn?.({
      queryKey: options.queryKey,
      pageParam: "older-cursor",
      direction: "forward",
      signal: new AbortController().signal,
      client: new QueryClient(),
      meta: undefined,
    });
    expect(listTimelinePage).toHaveBeenCalledWith("issue-1", {
      issueSessionId: "session-main",
      before: "older-cursor",
      limit: ISSUE_TIMELINE_PAGE_SIZE,
    });
  });

  it("primes the server-resolved default session without waiting for session data", async () => {
    const listTimelinePage = vi.fn().mockResolvedValue(page(false));
    setApiInstance({ listTimelinePage } as unknown as ApiClient);
    const options = issueTimelinePrimerOptions("issue-1");

    await options.queryFn?.({
      queryKey: options.queryKey,
      signal: new AbortController().signal,
      client: new QueryClient(),
      meta: undefined,
    });
    expect(listTimelinePage).toHaveBeenCalledWith("issue-1", {
      issueSessionId: "@default",
      limit: ISSUE_TIMELINE_PAGE_SIZE,
    });
  });
});

function makeIssue(idx: number): Issue {
  return {
    id: `issue-${idx}`,
    workspace_id: WS_ID,
    number: idx,
    identifier: `MUL-${idx}`,
    title: `Issue ${idx}`,
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: PROJECT_ID,
    position: idx,
    start_date: "2026-05-01T00:00:00Z",
    due_date: null,
    labels: [],
    metadata: {},
    completed_at: null,
    archived_at: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
}

// Type-only shim — only the methods the queries.ts code path under test calls.
function installFakeApi(listIssues: (params?: ListIssuesParams) => Promise<ListIssuesResponse>) {
  setApiInstance({ listIssues } as unknown as ApiClient);
}

describe("archived issue queries", () => {
  it("uses a one-row request for the hidden-column count and a separate list page", async () => {
    const listIssues = vi
      .fn<(params?: ListIssuesParams) => Promise<ListIssuesResponse>>()
      .mockResolvedValue({ issues: [makeIssue(1)], total: 7 });
    installFakeApi(listIssues);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    expect(await qc.fetchQuery(archivedIssueCountOptions(WS_ID))).toBe(7);
    expect(await qc.fetchQuery(archivedIssueListOptions(WS_ID))).toMatchObject({ total: 7 });
    expect(listIssues).toHaveBeenNthCalledWith(1, {
      archived_only: true,
      limit: 1,
      offset: 0,
    });
    expect(listIssues).toHaveBeenNthCalledWith(2, {
      archived_only: true,
      limit: 50,
      offset: 0,
    });
    qc.clear();
  });
});

function installFakeChildrenApi(
  listChildrenByParents: (parentIds: string[]) => Promise<{ issues: Issue[] }>,
) {
  setApiInstance({ listChildrenByParents } as unknown as ApiClient);
}

describe("projectGanttIssuesOptions", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("returns the first page directly when it fits under PROJECT_GANTT_PAGE_LIMIT", async () => {
    const listIssues = vi
      .fn<(params?: ListIssuesParams) => Promise<ListIssuesResponse>>()
      .mockResolvedValue({
        issues: [makeIssue(1), makeIssue(2)],
        total: 2,
      });
    installFakeApi(listIssues);

    const data = await qc.fetchQuery(projectGanttIssuesOptions(WS_ID, PROJECT_ID));

    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      scheduled: true,
      limit: PROJECT_GANTT_PAGE_LIMIT,
      offset: 0,
    });
    expect(data).toHaveLength(2);
  });

  it("loops through pages until total is satisfied (no silent truncation)", async () => {
    const total = PROJECT_GANTT_PAGE_LIMIT + 7;
    const firstPage = Array.from({ length: PROJECT_GANTT_PAGE_LIMIT }, (_, i) =>
      makeIssue(i),
    );
    const secondPage = Array.from({ length: 7 }, (_, i) =>
      makeIssue(PROJECT_GANTT_PAGE_LIMIT + i),
    );

    const listIssues = vi
      .fn<(params?: ListIssuesParams) => Promise<ListIssuesResponse>>()
      .mockImplementation(async (params) => {
        if (!params) throw new Error("expected params");
        const offset = params.offset ?? 0;
        if (offset === 0)
          return { issues: firstPage, total };
        if (offset === PROJECT_GANTT_PAGE_LIMIT)
          return { issues: secondPage, total };
        throw new Error(`unexpected offset ${offset}`);
      });
    installFakeApi(listIssues);

    const data = await qc.fetchQuery(projectGanttIssuesOptions(WS_ID, PROJECT_ID));

    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(data).toHaveLength(total);
  });

  it("stops looping when the server reports a smaller-than-limit page (safety net for total drift)", async () => {
    // Server says `total` is huge but only ever returns short pages — the
    // loop must terminate on the first short page to avoid an infinite fetch.
    const listIssues = vi
      .fn<(params?: ListIssuesParams) => Promise<ListIssuesResponse>>()
      .mockResolvedValue({
        issues: [makeIssue(1)],
        total: PROJECT_GANTT_MAX_ISSUES,
      });
    installFakeApi(listIssues);

    const data = await qc.fetchQuery(projectGanttIssuesOptions(WS_ID, PROJECT_ID));

    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(data).toHaveLength(1);
  });

  it("uses the project-scoped Gantt cache key", () => {
    const options = projectGanttIssuesOptions(WS_ID, PROJECT_ID);
    expect(options.queryKey).toEqual(issueKeys.projectGantt(WS_ID, PROJECT_ID));
  });
});

describe("childrenByParentsOptions chunking", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("issues a single request when parentIds fit under the chunk size", async () => {
    const parentIds = Array.from({ length: 50 }, (_, i) => `p-${i}`);
    const listChildrenByParents = vi
      .fn<(ids: string[]) => Promise<{ issues: Issue[] }>>()
      .mockResolvedValue({ issues: [] });
    installFakeChildrenApi(listChildrenByParents);

    await qc.fetchQuery(childrenByParentsOptions(WS_ID, parentIds, qc));

    expect(listChildrenByParents).toHaveBeenCalledTimes(1);
    expect(listChildrenByParents).toHaveBeenCalledWith(parentIds);
  });

  it("chunks parentIds into multiple requests when over the server cap", async () => {
    // 2.5 chunks worth of parents → 3 parallel requests.
    const count = CHILDREN_BY_PARENTS_CHUNK_SIZE * 2 + 17;
    const parentIds = Array.from({ length: count }, (_, i) => `p-${i}`);
    const calls: string[][] = [];
    const listChildrenByParents = vi
      .fn<(ids: string[]) => Promise<{ issues: Issue[] }>>()
      .mockImplementation(async (ids) => {
        calls.push(ids);
        return { issues: [] };
      });
    installFakeChildrenApi(listChildrenByParents);

    await qc.fetchQuery(childrenByParentsOptions(WS_ID, parentIds, qc));

    expect(listChildrenByParents).toHaveBeenCalledTimes(3);
    expect(calls[0]).toHaveLength(CHILDREN_BY_PARENTS_CHUNK_SIZE);
    expect(calls[1]).toHaveLength(CHILDREN_BY_PARENTS_CHUNK_SIZE);
    expect(calls[2]).toHaveLength(17);
    // Together the chunks must cover every input parent id.
    expect(calls.flat().sort()).toEqual(parentIds.slice().sort());
  });

  it("merges children from all chunks into one grouped map", async () => {
    const parentIds = Array.from(
      { length: CHILDREN_BY_PARENTS_CHUNK_SIZE + 1 },
      (_, i) => `p-${i}`,
    );
    // First chunk returns a child of p-0, second chunk returns a child of
    // the last parent id (which lives alone in chunk 2).
    const lastId = parentIds[parentIds.length - 1]!;
    const listChildrenByParents = vi
      .fn<(ids: string[]) => Promise<{ issues: Issue[] }>>()
      .mockImplementation(async (ids) => {
        if (ids.includes(lastId)) {
          return { issues: [{ ...makeIssue(99), parent_issue_id: lastId }] };
        }
        return { issues: [{ ...makeIssue(1), parent_issue_id: "p-0" }] };
      });
    installFakeChildrenApi(listChildrenByParents);

    const grouped = await qc.fetchQuery(
      childrenByParentsOptions(WS_ID, parentIds, qc),
    );

    expect(grouped.get("p-0")).toHaveLength(1);
    expect(grouped.get(lastId)).toHaveLength(1);
  });
});

describe("findCachedIssue", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    qc.clear();
  });

  /** The bucketed shape `issueListOptions` caches (pre-`select`). */
  function seed(key: readonly unknown[], issues: Issue[]) {
    qc.setQueryData(key, {
      byStatus: { todo: { issues, total: issues.length } },
    });
  }

  it("finds an issue cached under a sorted key when the caller knows no sort", () => {
    // The MUL-172 regression: the list page writes under `listSorted(ws, sort)`,
    // and a lookup-only caller has no sort to pass. Matching on the shared
    // prefix is what makes the seed hit instead of triggering a fresh fan-out.
    seed(issueKeys.listSorted(WS_ID, { sort_by: "priority" }), [makeIssue(7)]);

    expect(findCachedIssue(qc, WS_ID, "issue-7")?.identifier).toBe("MUL-7");
  });

  it("also reads the my-issues caches, so the seed survives either entry path", () => {
    seed(issueKeys.myListSorted(WS_ID, "all", {}, { sort_by: "priority" }), [makeIssue(9)]);

    expect(findCachedIssue(qc, WS_ID, "issue-9")?.identifier).toBe("MUL-9");
  });

  it("never issues a request — a cache miss returns undefined, not a fetch", () => {
    const listIssues = vi
      .fn<(params?: ListIssuesParams) => Promise<ListIssuesResponse>>()
      .mockResolvedValue({ issues: [makeIssue(1)], total: 1 });
    installFakeApi(listIssues);

    expect(findCachedIssue(qc, WS_ID, "issue-absent")).toBeUndefined();
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("ignores caches under the same prefix that are not bucketed lists", () => {
    // `myAll` also covers assignee-group queries, which cache a
    // GroupedIssuesResponse — reading those must not throw.
    qc.setQueryData(issueKeys.myAssigneeGroups(WS_ID, "all", {}), { groups: [] });
    seed(issueKeys.listSorted(WS_ID), [makeIssue(3)]);

    expect(findCachedIssue(qc, WS_ID, "issue-3")?.identifier).toBe("MUL-3");
  });

  it("scopes to the workspace", () => {
    seed(issueKeys.listSorted(WS_ID), [makeIssue(5)]);

    expect(findCachedIssue(qc, "ws-other", "issue-5")).toBeUndefined();
  });
});
