import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  PAGINATED_STATUSES, issueAssigneeGroupsOptions, issueKeys, issueListOptions,
  type IssueSortParam,
} from "./queries";
import { onIssueUpdated } from "./ws-updaters";

const WS = "ws_archive_races";
const writers = ["status-pages", "assignee-groups"] as const;
type Writer = typeof writers[number];
const clients: QueryClient[] = [];

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: Infinity, gcTime: Infinity,
  } } });
  clients.push(qc);
  return qc;
}

function options(writer: Writer, sort?: IssueSortParam, wsId = WS) {
  if (writer === "status-pages") {
    const source = issueListOptions(wsId, sort);
    return { queryKey: source.queryKey, fetch: (qc: QueryClient) => qc.fetchQuery(source),
      observe: (qc: QueryClient) => new QueryObserver(qc, source) };
  }
  const source = issueAssigneeGroupsOptions(wsId, {}, sort);
  return { queryKey: source.queryKey, fetch: (qc: QueryClient) => qc.fetchQuery(source),
    observe: (qc: QueryClient) => new QueryObserver(qc, source) };
}

function fixture() {
  const pending: ((total: number) => void)[] = [];
  const count = () => new Promise<number>((resolve) => { pending.push(resolve); });
  const listIssueStatusPages = vi.fn(async () => ({
    archived_total: await count(),
    groups: Object.fromEntries(PAGINATED_STATUSES.map((status) => [status, {
      issues: [], total: 0, has_more: false,
    }])),
  }));
  const listGroupedIssues = vi.fn(async () => ({ archived_total: await count(), groups: [] }));
  setApiInstance({ listIssueStatusPages, listGroupedIssues } as unknown as ApiClient);
  return { pending, listIssueStatusPages, listGroupedIssues };
}

// Drain the queryFn continuation even when TanStack has already canceled its promise.
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { clients.splice(0).forEach((qc) => qc.clear()); });

describe("inline archive count response ordering", () => {
  it.each(writers)("%s: canceled response cannot publish even without a replacement request", async (writer) => {
    const h = fixture();
    const qc = client();
    qc.setQueryData(issueKeys.archivedCount(WS), 1);
    const source = options(writer);
    const canceled = source.fetch(qc).catch(() => undefined);
    await qc.cancelQueries({ queryKey: source.queryKey, exact: true });
    h.pending[0]!(0);
    await canceled;
    await settle();
    expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1);
  });

  it.each(writers)("%s: canceled response cannot undo a newer archive WS refetch", async (writer) => {
    const h = fixture();
    const qc = client();
    const observer = options(writer).observe(qc);
    const stop = observer.subscribe(() => {});
    try {
      h.pending[0]!(0);
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(0);
      const oldRefetch = observer.refetch();
      expect(h.pending).toHaveLength(2);
      onIssueUpdated(qc, WS, { id: "iss_archive_race", archived_at: "2026-09-29" });
      expect(h.pending).toHaveLength(3);
      h.pending[2]!(1);
      await vi.waitFor(() => expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1));
      h.pending[1]!(0);
      await oldRefetch;
      await settle();
      expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1);
    } finally { stop(); }
  });

  it.each(writers.flatMap((old) => writers.map((newer) => [old, newer] as const)))(
    "uncanceled %s response cannot overwrite a later %s request across keys", async (old, newer) => {
      const h = fixture();
      const qc = client();
      const oldOptions = options(old, { sort_by: "priority" });
      const newOptions = options(newer, { sort_by: "created_at" });
      expect(oldOptions.queryKey).not.toEqual(newOptions.queryKey);
      const slow = oldOptions.fetch(qc);
      const fast = newOptions.fetch(qc);
      expect(h.pending).toHaveLength(2);
      h.pending[1]!(1);
      await fast;
      expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1);
      h.pending[0]!(0);
      await slow;
      expect(qc.getQueryState(oldOptions.queryKey)?.status).toBe("success");
      expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1);
    },
  );

  it.each(writers)("%s: opt-in count follows normal archive and restore WS updates", async (writer) => {
    const h = fixture();
    const qc = client();
    const observer = options(writer).observe(qc);
    const stop = observer.subscribe(() => {});
    try {
      h.pending[0]!(0);
      await vi.waitFor(() => expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(0));
      const api = writer === "status-pages" ? h.listIssueStatusPages : h.listGroupedIssues;
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ include_archived_total: true }));
      for (const [archived_at, total] of [["2026-09-29", 1], [null, 0]] as const) {
        onIssueUpdated(qc, WS, { id: "iss_archive_race", archived_at });
        h.pending.at(-1)!(total);
        await vi.waitFor(() => expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(total));
      }
      expect(h.pending).toHaveLength(3);
    } finally { stop(); }
  });

  it.each(writers)("%s: response cannot undo a newer optimistic count write", async (writer) => {
    const h = fixture();
    const qc = client();
    qc.setQueryData(issueKeys.archivedCount(WS), 1);
    const old = options(writer).fetch(qc);
    qc.setQueryData(issueKeys.archivedCount(WS), 0);
    h.pending[0]!(1);
    await old;
    expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(0);
  });

  it("isolates request ordering by workspace and QueryClient", async () => {
    const h = fixture();
    const qc = client();
    const other = client();
    const requests = [options("status-pages").fetch(qc),
      options("assignee-groups", undefined, "ws_other").fetch(qc),
      options("status-pages").fetch(other)];
    for (const index of [2, 1, 0]) h.pending[index]!(index + 1);
    await Promise.all(requests);
    expect(qc.getQueryData(issueKeys.archivedCount(WS))).toBe(1);
    expect(qc.getQueryData(issueKeys.archivedCount("ws_other"))).toBe(2);
    expect(other.getQueryData(issueKeys.archivedCount(WS))).toBe(3);
  });
});
