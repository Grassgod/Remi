import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { ApiClient } from "../api/client";
import { setApiInstance } from "../api";
import type { Issue, ListIssuesCache, ListIssuesParams } from "../types";
import {
  ISSUE_PAGE_SIZE, PAGINATED_STATUSES, archivedIssueCountOptions, issueAssigneeGroupsOptions,
  issueKeys, issueListOptions, myIssueListOptions, reconcileIssueBuckets, type IssueSortParam,
} from "./queries";
import { onIssueUpdated } from "./ws-updaters";

const WS = "ws_status_pages";
const SORT: IssueSortParam = { sort_by: "priority", sort_direction: "desc", top_level_only: true };
const rows: Issue[] = PAGINATED_STATUSES.flatMap((status, lane) => Array.from({ length: status === "blocked" ? 0 : 120 }, (_, i) => ({
  id: `iss_${status}_${i}`, workspace_id: WS, number: lane * 120 + i, identifier: `MUL-${lane * 120 + i}`,
  title: `Issue ${i}`, description: `Body ${i}`, status, priority: i % 2 ? "high" : "low",
  assignee_type: i % 3 ? "member" : "agent", assignee_id: i % 3 ? "mem_reader" : "agt_reader",
  creator_type: "member", creator_id: i % 4 ? "usr_reader" : "usr_other", parent_issue_id: i % 7 ? null : "iss_parent",
  project_id: i % 2 ? "prj_primary" : "prj_other", position: i, start_date: null, due_date: null,
  labels: [], metadata: { fixture: true }, created_at: "2026-09-28", updated_at: `2026-09-${String(i % 28 + 1).padStart(2, "0")}`,
  archived_at: null, completed_at: null,
})));

function fixture(missing = false) {
  const requests: URL[] = [];
  let archiveCount = 7;
  const list = (search: URLSearchParams) => {
    if (search.get("archived_only") === "true") return { issues: [], total: archiveCount };
    const assignee = search.get("assignee_id");
    const id = assignee === "agt_reader" ? assignee : assignee ? "mem_reader" : null;
    let selected = rows.filter((row) => (!search.get("status") || row.status === search.get("status"))
      && (!id || row.assignee_id === id)
      && (!search.get("creator_id") || row.creator_id === search.get("creator_id"))
      && (!search.get("involves_user_id") || row.assignee_type === "agent")
      && (!search.get("project_id") || row.project_id === search.get("project_id"))
      && (search.get("top_level_only") !== "true" || !row.parent_issue_id));
    const key = search.get("sort") === "priority" ? "priority" : "updated_at";
    selected = selected.toSorted((a, b) => (search.get("direction") === "asc" ? 1 : -1) * String(a[key]).localeCompare(String(b[key])));
    const offset = Number(search.get("offset") ?? 0);
    return { issues: selected.slice(offset, offset + Number(search.get("limit") ?? 50)), total: selected.length };
  };
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    if (url.pathname === "/api/issues") return Response.json(list(url.searchParams));
    if (url.pathname === "/api/issues/grouped") return Response.json({ groups: [],
      ...(url.searchParams.has("include_archived_total") ? { archived_total: archiveCount } : {}) });
    if (url.pathname !== "/api/issues/status-pages") throw new Error(`Unexpected fixture route: ${url.pathname}`);
    if (missing) return Response.json({ error: "not found" }, { status: 404 });
    const groups = Object.fromEntries(url.searchParams.get("statuses")!.split(",").map((status) => {
      const search = new URLSearchParams(url.searchParams);
      search.set("status", status);
      const page = list(search);
      return [status, { ...page, has_more: page.issues.length < page.total }];
    }));
    return Response.json({ groups, ...(url.searchParams.has("include_archived_total") ? { archived_total: archiveCount } : {}) });
  });
  vi.stubGlobal("fetch", fetch);
  const api = new ApiClient("http://status-pages.test");
  setApiInstance(api);
  return { api, requests, fetch, setArchiveCount: (total: number) => { archiveCount = total; } };
}

const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
}

async function oldPages(api: ApiClient, filter: ListIssuesParams = {}, sort?: IssueSortParam) {
  const responses = await Promise.all(PAGINATED_STATUSES.map(async (status) => ({
    ...await api.listIssues({ status, limit: ISSUE_PAGE_SIZE, offset: 0, ...sort, ...filter }), status,
  })));
  return reconcileIssueBuckets(responses);
}

afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

describe("status-pages cache equivalence", () => {
  it.each([{}, { top_level_only: true }, { sort_by: "priority", sort_direction: "desc" }, SORT] as IssueSortParam[])(
    "workspace buckets retain every field, order and empty state for %j", async (sort) => {
      const { api } = fixture();
      const expected = await oldPages(api, {}, sort);
      const qc = client();
      await qc.fetchQuery(issueListOptions(WS, sort));
      expect(qc.getQueryData(issueKeys.listSorted(WS, sort))).toEqual(expected);
      expect(JSON.stringify(qc.getQueryData(issueKeys.listSorted(WS, sort)))).toBe(JSON.stringify(expected));
      expect(expected.byStatus.blocked).toEqual({ issues: [], total: 0 });
      expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(7);
    },
  );

  it.each(["usr_reader", "mem_reader", "agt_reader", "reader"])("personal filtered/sorted/project buckets match for %s", async (assignee_id) => {
    const { api } = fixture();
    const filter = { assignee_id, project_id: "prj_primary", top_level_only: true };
    const expected = await oldPages(api, filter, SORT);
    const qc = client();
    const options = myIssueListOptions(WS, "assigned", filter, undefined, SORT);
    await qc.fetchQuery(options);
    expect(qc.getQueryData(options.queryKey)).toEqual(expected);
    expect(JSON.stringify(qc.getQueryData(options.queryKey))).toBe(JSON.stringify(expected));
  });

  it("All keeps the legacy assignee/creator/involves union order and merged totals", async () => {
    const { api } = fixture();
    const old = await Promise.all([
      oldPages(api, { assignee_id: "usr_reader", top_level_only: true }, SORT),
      oldPages(api, { creator_id: "usr_reader", top_level_only: true }, SORT),
      oldPages(api, { involves_user_id: "usr_reader", top_level_only: true }, SORT),
    ]);
    const expected: ListIssuesCache = { byStatus: {} };
    for (const status of PAGINATED_STATUSES) {
      const unique = new Map<string, Issue>();
      for (const cache of old) for (const issue of cache.byStatus[status]!.issues) if (!unique.has(issue.id)) unique.set(issue.id, issue);
      expected.byStatus[status] = { issues: [...unique.values()], total: unique.size };
    }
    const qc = client();
    const options = myIssueListOptions(WS, "all", { top_level_only: true }, "usr_reader", SORT);
    await qc.fetchQuery(options);
    expect(qc.getQueryData(options.queryKey)).toEqual(expected);
  });
});

describe("first-screen request guards", () => {
  it.each(["issues", "assigned", "all"])("%s cold open and warm invalidate/refetch/focus stay grouped", async (scope) => {
    const h = fixture();
    const qc = client();
    const options = scope === "issues" ? issueListOptions(WS, SORT)
      : myIssueListOptions(WS, scope, { assignee_id: "usr_reader", top_level_only: true }, "usr_reader", SORT);
    const observer = scope === "issues" ? new QueryObserver(qc, issueListOptions(WS, SORT))
      : new QueryObserver(qc, myIssueListOptions(WS, scope, { assignee_id: "usr_reader", top_level_only: true }, "usr_reader", SORT));
    const stop = observer.subscribe(() => {});
    const counter = new QueryObserver(qc, archivedIssueCountOptions(WS));
    const stopCounter = scope === "issues" ? counter.subscribe(() => {}) : () => {};
    const expected = scope === "all" ? 3 : 1;
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      expect(h.requests).toHaveLength(expected);
      expect(h.requests.every((url) => url.pathname === "/api/issues/status-pages")).toBe(true);
      if (scope === "issues") expect(counter.getCurrentResult().data).toBe(7);
      h.requests.length = 0;
      await qc.invalidateQueries({ queryKey: scope === "issues" ? issueKeys.list(WS) : issueKeys.myAll(WS) });
      expect(h.requests).toHaveLength(expected);
      expect(h.requests.every((url) => url.pathname === "/api/issues/status-pages")).toBe(true);
      h.requests.length = 0;
      await observer.refetch();
      expect(h.requests).toHaveLength(expected);
      h.requests.length = 0;
      await qc.invalidateQueries({ queryKey: options.queryKey, refetchType: "none" });
      qc.getQueryCache().onFocus();
      await vi.waitFor(() => expect(h.requests).toHaveLength(expected));
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
      expect(h.requests.every((url) => url.pathname === "/api/issues/status-pages")).toBe(true);
    } finally { stop(); stopCounter(); }
  });

  it("archive invalidation refreshes the inline count and never fetches a hidden archive list", async () => {
    const h = fixture();
    const qc = client();
    const observer = new QueryObserver(qc, issueListOptions(WS));
    const stop = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      h.requests.length = 0;
      h.setArchiveCount(8);
      onIssueUpdated(qc, WS, { id: rows[0]!.id, archived_at: "2026-09-28" });
      await vi.waitFor(() => expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(8));
      expect(h.requests.map((url) => url.pathname)).toEqual(["/api/issues/status-pages"]);
      expect(h.requests[0]!.searchParams.get("include_archived_total")).toBe("true");
    } finally { stop(); }
  });

  it("assignee boards receive the archive count in their active grouped response", async () => {
    const h = fixture();
    const qc = client();
    await qc.fetchQuery(issueAssigneeGroupsOptions(WS, { project_id: "prj_primary" }, SORT));
    expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(7);
    expect(h.requests.map((url) => url.pathname)).toEqual(["/api/issues/grouped"]);
    expect(h.requests[0]!.searchParams.get("include_archived_total")).toBe("true");
  });
});

describe("API version fallback", () => {
  it("404 restores legacy page data and archive counts and is remembered across refetches", async () => {
    const h = fixture(true);
    const expected = await oldPages(h.api, {}, SORT);
    h.requests.length = 0;
    const qc = client();
    const options = issueListOptions(WS, SORT);
    await qc.fetchQuery(options);
    expect(qc.getQueryData(options.queryKey)).toEqual(expected);
    expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(7);
    expect(h.requests.filter((url) => url.pathname.endsWith("status-pages"))).toHaveLength(1);
    expect(h.requests.filter((url) => url.pathname === "/api/issues")).toHaveLength(7);
    h.requests.length = 0;
    await qc.invalidateQueries({ queryKey: issueKeys.list(WS) });
    await qc.fetchQuery(options);
    expect(h.requests.map((url) => url.pathname)).toEqual(Array(7).fill("/api/issues"));
    expect(qc.getQueryData(options.queryKey)).toEqual(expected);
  });

  it("concurrent All filters only probe 404 once, and new sessions can use the new API", async () => {
    const h = fixture(true);
    const qc = client();
    const options = myIssueListOptions(WS, "all", {}, "usr_reader");
    await qc.fetchQuery(options);
    expect(h.requests.filter((url) => url.pathname.endsWith("status-pages"))).toHaveLength(1);
    expect(h.requests.filter((url) => url.pathname === "/api/issues")).toHaveLength(18);
    const legacy = qc.getQueryData(options.queryKey);
    const fresh = fixture();
    await client().fetchQuery(options);
    expect(fresh.requests).toHaveLength(3);
    expect(qc.getQueryData(options.queryKey)).toEqual(legacy);
  });

  it.each([401, 500])("does not hide a %s as a version mismatch", async (status) => {
    const h = fixture();
    h.fetch.mockImplementation(async () => Response.json({ error: "unavailable" }, { status }));
    await expect(client().fetchQuery(issueListOptions(WS))).rejects.toMatchObject({ status });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
