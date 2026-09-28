/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  useLoadMoreArchivedIssues,
  useLoadMoreByAssigneeGroup,
  useLoadMoreByStatus,
  useGrantParentDone,
  useRevokeParentDone,
  useRestoreIssue,
} from "./mutations";
import {
  issueKeys,
  issueListOptions,
  PAGINATED_STATUSES,
  type IssueSortParam,
} from "./queries";
import type {
  GroupedIssuesResponse,
  Issue,
  ListIssuesCache,
  ListIssuesParams,
  ListGroupedIssuesParams,
  ListIssuesResponse,
} from "../types";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const WS_ID = "ws-1";

function makeIssue(idx: number, overrides: Partial<Issue> = {}): Issue {
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
    project_id: null,
    position: idx,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
    completed_at: overrides.completed_at ?? null,
    archived_at: overrides.archived_at ?? null,
  };
}

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useLoadMoreByStatus", () => {
  let qc: QueryClient;
  let listIssues: ReturnType<typeof vi.fn<(p?: ListIssuesParams) => Promise<ListIssuesResponse>>>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listIssues = vi.fn();
    setApiInstance({ listIssues } as unknown as ApiClient);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("continues a grouped first page at offset 50 without repeating or losing rows", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => makeIssue(i + 1));
    const listIssueStatusPages = vi.fn().mockResolvedValue({
      groups: Object.fromEntries(PAGINATED_STATUSES.map((status) => [status, {
        issues: status === "todo" ? rows.slice(0, 50) : [], total: status === "todo" ? 60 : 0,
        has_more: status === "todo",
      }])), archived_total: 0,
    });
    listIssues.mockResolvedValue({ issues: rows.slice(50), total: 60 });
    setApiInstance({ listIssueStatusPages, listIssues } as unknown as ApiClient);
    const sort: IssueSortParam = { sort_by: "priority", sort_direction: "desc" };
    await qc.fetchQuery(issueListOptions(WS_ID, sort));
    const { result } = renderHook(() => {
      useQuery({ ...issueListOptions(WS_ID, sort), staleTime: Infinity });
      return useLoadMoreByStatus("todo", undefined, sort);
    }, { wrapper: createWrapper(qc) });
    expect(result.current.hasMore).toBe(true);
    await act(async () => { await result.current.loadMore(); });
    expect(listIssueStatusPages).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledExactlyOnceWith({ status: "todo", limit: 50, offset: 50, ...sort });
    expect(qc.getQueryData<ListIssuesCache>(issueKeys.listSorted(WS_ID, sort))?.byStatus.todo).toEqual({ issues: rows, total: 60 });
    await waitFor(() => expect(result.current.hasMore).toBe(false));
  });

  it("targets the sorted cache key and forwards sort to the API", async () => {
    const sort: IssueSortParam = { sort_by: "priority", sort_direction: "desc" };
    const activeKey = issueKeys.listSorted(WS_ID, sort);
    const seed: ListIssuesCache = {
      byStatus: {
        todo: { issues: [makeIssue(1)], total: 3 },
      },
    };
    qc.setQueryData<ListIssuesCache>(activeKey, seed);

    listIssues.mockResolvedValue({
      issues: [makeIssue(2), makeIssue(3)],
      total: 3,
    });

    const { result } = renderHook(
      () => useLoadMoreByStatus("todo", undefined, sort),
      { wrapper: createWrapper(qc) },
    );

    expect(result.current.hasMore).toBe(true);
    expect(result.current.total).toBe(3);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(listIssues).toHaveBeenCalledWith({
      status: "todo",
      limit: 50,
      offset: 1,
      sort_by: "priority",
      sort_direction: "desc",
    });

    const updated = qc.getQueryData<ListIssuesCache>(activeKey);
    expect(updated?.byStatus.todo?.issues).toHaveLength(3);
    expect(updated?.byStatus.todo?.issues.map((i) => i.id)).toEqual([
      "issue-1",
      "issue-2",
      "issue-3",
    ]);
  });

  it("ignores a stale cache entry under a different sort", async () => {
    // Stale entry from a previous sort lingers (kept by gcTime / keepPreviousData).
    const staleSort: IssueSortParam = { sort_by: "priority", sort_direction: "desc" };
    qc.setQueryData<ListIssuesCache>(issueKeys.listSorted(WS_ID, staleSort), {
      byStatus: { todo: { issues: [makeIssue(99)], total: 99 } },
    });

    // The active sort cache has its own bucket — load-more must target THIS one.
    const activeSort: IssueSortParam = { sort_by: "position", sort_direction: undefined };
    const activeKey = issueKeys.listSorted(WS_ID, activeSort);
    qc.setQueryData<ListIssuesCache>(activeKey, {
      byStatus: { todo: { issues: [makeIssue(1)], total: 2 } },
    });

    listIssues.mockResolvedValue({
      issues: [makeIssue(2)],
      total: 2,
    });

    const { result } = renderHook(
      () => useLoadMoreByStatus("todo", undefined, activeSort),
      { wrapper: createWrapper(qc) },
    );

    // total derives from the active key, not the stale one.
    expect(result.current.total).toBe(2);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 1, sort_by: "position" }),
    );

    const active = qc.getQueryData<ListIssuesCache>(activeKey);
    expect(active?.byStatus.todo?.issues.map((i) => i.id)).toEqual([
      "issue-1",
      "issue-2",
    ]);

    // Stale cache is untouched.
    const stale = qc.getQueryData<ListIssuesCache>(issueKeys.listSorted(WS_ID, staleSort));
    expect(stale?.byStatus.todo?.issues.map((i) => i.id)).toEqual(["issue-99"]);
  });

  it("targets the myList scoped cache when myIssues is provided", async () => {
    const sort: IssueSortParam = { sort_by: "title", sort_direction: "asc" };
    const myIssues = { scope: "assigned", filter: { assignee_id: "user-1" } };
    const activeKey = issueKeys.myListSorted(WS_ID, myIssues.scope, myIssues.filter, sort);
    qc.setQueryData<ListIssuesCache>(activeKey, {
      byStatus: { in_progress: { issues: [makeIssue(1, { status: "in_progress" })], total: 2 } },
    });

    listIssues.mockResolvedValue({
      issues: [makeIssue(2, { status: "in_progress" })],
      total: 2,
    });

    const { result } = renderHook(
      () => useLoadMoreByStatus("in_progress", myIssues, sort),
      { wrapper: createWrapper(qc) },
    );

    await act(async () => {
      await result.current.loadMore();
    });

    expect(listIssues).toHaveBeenCalledWith({
      status: "in_progress",
      limit: 50,
      offset: 1,
      sort_by: "title",
      sort_direction: "asc",
      assignee_id: "user-1",
    });

    const updated = qc.getQueryData<ListIssuesCache>(activeKey);
    expect(updated?.byStatus.in_progress?.issues).toHaveLength(2);
  });

  it("works with no sort (matches the {} key used by sort-less callers)", async () => {
    const myIssues = { scope: "actor", filter: { assignee_id: "user-2" } };
    const activeKey = issueKeys.myListSorted(WS_ID, myIssues.scope, myIssues.filter, undefined);
    qc.setQueryData<ListIssuesCache>(activeKey, {
      byStatus: { todo: { issues: [makeIssue(1)], total: 2 } },
    });

    listIssues.mockResolvedValue({ issues: [makeIssue(2)], total: 2 });

    const { result } = renderHook(
      () => useLoadMoreByStatus("todo", myIssues),
      { wrapper: createWrapper(qc) },
    );

    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    const updated = qc.getQueryData<ListIssuesCache>(activeKey);
    expect(updated?.byStatus.todo?.issues).toHaveLength(2);
  });
});

describe("useLoadMoreByAssigneeGroup", () => {
  let qc: QueryClient;
  let listGroupedIssues: ReturnType<
    typeof vi.fn<(p: ListGroupedIssuesParams) => Promise<GroupedIssuesResponse>>
  >;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listGroupedIssues = vi.fn();
    setApiInstance({ listGroupedIssues } as unknown as ApiClient);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("forwards sort to the grouped API and appends into the right group", async () => {
    const sort: IssueSortParam = { sort_by: "priority", sort_direction: "desc" };
    const queryKey = ["custom", "assignee-groups", "ws-1"] as const;
    const seed: GroupedIssuesResponse = {
      groups: [
        {
          id: "assignee:member:user-1",
          assignee_type: "member",
          assignee_id: "user-1",
          issues: [makeIssue(1, { assignee_type: "member", assignee_id: "user-1" })],
          total: 2,
        },
      ],
    };
    qc.setQueryData<GroupedIssuesResponse>(queryKey, seed);

    listGroupedIssues.mockResolvedValue({
      groups: [
        {
          id: "assignee:member:user-1",
          assignee_type: "member",
          assignee_id: "user-1",
          issues: [makeIssue(2, { assignee_type: "member", assignee_id: "user-1" })],
          total: 2,
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useLoadMoreByAssigneeGroup(
          {
            id: "assignee:member:user-1",
            assignee_type: "member",
            assignee_id: "user-1",
          },
          queryKey,
          { statuses: ["todo"] },
          sort,
        ),
      { wrapper: createWrapper(qc) },
    );

    expect(result.current.hasMore).toBe(true);
    expect(result.current.total).toBe(2);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(listGroupedIssues).toHaveBeenCalledWith({
      group_by: "assignee",
      limit: 50,
      offset: 1,
      sort_by: "priority",
      sort_direction: "desc",
      statuses: ["todo"],
      group_assignee_type: "member",
      group_assignee_id: "user-1",
    });

    const updated = qc.getQueryData<GroupedIssuesResponse>(queryKey);
    expect(updated?.groups[0]?.issues.map((i) => i.id)).toEqual([
      "issue-1",
      "issue-2",
    ]);
  });
});

describe("archived issue mutations", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("paginates the independent archived list cache", async () => {
    const listIssues = vi.fn().mockResolvedValue({
      issues: [makeIssue(2, { archived_at: "2026-01-02T00:00:00Z" })],
      total: 2,
    });
    setApiInstance({ listIssues } as unknown as ApiClient);
    const key = issueKeys.archivedListSorted(WS_ID, undefined);
    qc.setQueryData<ListIssuesResponse>(key, {
      issues: [makeIssue(1, { archived_at: "2026-01-01T00:00:00Z" })],
      total: 2,
    });

    const { result } = renderHook(() => useLoadMoreArchivedIssues(), {
      wrapper: createWrapper(qc),
    });
    await act(async () => result.current.loadMore());

    expect(listIssues).toHaveBeenCalledWith({
      archived_only: true,
      limit: 50,
      offset: 1,
    });
    expect(qc.getQueryData<ListIssuesResponse>(key)?.issues).toHaveLength(2);
  });

  it("optimistically removes a restored issue and returns it to the active status bucket", async () => {
    const restored = makeIssue(1, { status: "done", completed_at: null, archived_at: null });
    const restoreIssue = vi.fn().mockResolvedValue(restored);
    setApiInstance({ restoreIssue } as unknown as ApiClient);
    const archivedKey = issueKeys.archivedListSorted(WS_ID, undefined);
    const archived = makeIssue(1, {
      status: "done",
      completed_at: "2026-01-01T00:00:00Z",
      archived_at: "2026-01-04T00:00:00Z",
    });
    qc.setQueryData<ListIssuesResponse>(archivedKey, { issues: [archived], total: 1 });
    qc.setQueryData(issueKeys.archivedCount(WS_ID), 1);
    qc.setQueryData<ListIssuesCache>(issueKeys.listSorted(WS_ID, undefined), {
      byStatus: { done: { issues: [], total: 0 } },
    });

    const { result } = renderHook(() => useRestoreIssue(), {
      wrapper: createWrapper(qc),
    });
    await act(async () => result.current.mutateAsync(archived.id));

    expect(qc.getQueryData<ListIssuesResponse>(archivedKey)).toEqual({ issues: [], total: 0 });
    expect(qc.getQueryData(issueKeys.archivedCount(WS_ID))).toBe(0);
    expect(
      qc.getQueryData<ListIssuesCache>(issueKeys.listSorted(WS_ID, undefined))?.byStatus.done?.issues,
    ).toEqual([restored]);
  });
});

describe("parent done grant mutations", () => {
  let qc: QueryClient;
  let grantParentDone: ReturnType<typeof vi.fn>;
  let revokeParentDone: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    grantParentDone = vi.fn().mockResolvedValue({
      granted_at: "2026-09-28T00:00:00.000Z",
      granted_by: "member-1",
      agent_id: "agent-1",
      effective: true,
      ineffective_reason: null,
    });
    revokeParentDone = vi.fn().mockResolvedValue(null);
    setApiInstance({ grantParentDone, revokeParentDone } as unknown as ApiClient);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("grants and invalidates the server-derived detail state", async () => {
    const detailKey = issueKeys.detail(WS_ID, "issue-1");
    qc.setQueryData(detailKey, makeIssue(1));
    const { result } = renderHook(() => useGrantParentDone(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => result.current.mutateAsync("issue-1"));

    expect(grantParentDone).toHaveBeenCalledWith("issue-1");
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it("revokes and invalidates the server-derived detail state", async () => {
    const detailKey = issueKeys.detail(WS_ID, "issue-1");
    qc.setQueryData(detailKey, makeIssue(1));
    const { result } = renderHook(() => useRevokeParentDone(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => result.current.mutateAsync("issue-1"));

    expect(revokeParentDone).toHaveBeenCalledWith("issue-1");
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });
});
