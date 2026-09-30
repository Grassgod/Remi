import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { archivedTotalRequestStateForTesting } from "./archive-total-requests";
import { PAGINATED_STATUSES, issueAssigneeGroupsOptions, issueKeys, issueListOptions } from "./queries";

const writers = ["status", "assignee"] as const;
type Writer = typeof writers[number];
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
}
function source(writer: Writer, ws = "ws_a", sort_by?: "priority" | "created_at") {
  if (writer === "status") {
    const options = issueListOptions(ws, { sort_by });
    return { queryKey: options.queryKey, observe: (qc: QueryClient) => new QueryObserver(qc, options),
      fetch: (qc: QueryClient) => {
        const result = qc.fetchQuery({ ...options, staleTime: 0 });
        void result.catch(() => {});
        return result;
      } };
  }
  const options = issueAssigneeGroupsOptions(ws, {}, { sort_by });
  return { queryKey: options.queryKey, observe: (qc: QueryClient) => new QueryObserver(qc, options),
    fetch: (qc: QueryClient) => {
      const result = qc.fetchQuery({ ...options, staleTime: 0 });
      void result.catch(() => {});
      return result;
    } };
}
function fixture() {
  const pending: { resolve: (count: number) => void; reject: (error: Error) => void }[] = [];
  const defer = () => new Promise<number>((resolve, reject) => pending.push({ resolve, reject }));
  setApiInstance({
    listIssueStatusPages: vi.fn(async () => ({ archived_total: await defer(), groups: Object.fromEntries(
      PAGINATED_STATUSES.map((status) => [status, { issues: [], total: 0, has_more: false }]),
    ) })),
    listGroupedIssues: vi.fn(async () => ({ archived_total: await defer(), groups: [] })),
  } as unknown as ApiClient);
  return pending;
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const empty = (qc: QueryClient) => expect(archivedTotalRequestStateForTesting(qc)).toEqual({ count: 0, hasClient: false });
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

describe.each(writers)("archive request lifecycle: %s", (writer) => {
  it("does not retain completed markers across ws_a -> ws_b -> ws_a", async () => {
    const pending = fixture(); const qc = client();
    for (const [index, ws] of ["ws_a", "ws_b", "ws_a"].entries()) {
      const result = source(writer, ws).fetch(qc);
      expect(archivedTotalRequestStateForTesting(qc).count).toBe(1);
      pending[index]!.resolve(index);
      await result;
      empty(qc);
      expect(qc.getQueryData(issueKeys.archivedCount(ws))).toBe(index);
    }
    qc.clear(); empty(qc);
  });

  it("cleans a failure and can publish on retry", async () => {
    const pending = fixture(); const qc = client();
    const failure = source(writer).fetch(qc).catch(() => undefined);
    pending[0]!.reject(new Error("request failed"));
    await failure; empty(qc);
    const retry = source(writer).fetch(qc);
    pending[1]!.resolve(2); await retry; empty(qc);
    expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBe(2);
  });

  it.each(["cancel", "clear", "remove"] as const)("%s cleans even while the transport never settles", async (action) => {
    const pending = fixture(); const qc = client(); const options = source(writer);
    const result = options.fetch(qc).catch(() => undefined);
    expect(archivedTotalRequestStateForTesting(qc).count).toBe(1);
    if (action === "cancel") await qc.cancelQueries({ queryKey: options.queryKey, exact: true });
    else if (action === "clear") qc.clear();
    else qc.removeQueries({ queryKey: options.queryKey, exact: true });
    await result; await settle(); empty(qc);
    // A subsequently arriving transport result has no authority to recreate the count.
    pending[0]!.resolve(9); await settle(); empty(qc);
    expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBeUndefined();
  });

  it("unmount lets the shared initial request finish, then releases its marker", async () => {
    const pending = fixture(); const qc = client();
    const observer = source(writer).observe(qc);
    const stop = observer.subscribe(() => {});
    stop();
    await settle();
    expect(pending).toHaveLength(1);
    expect(qc.getQueryState(source(writer).queryKey)?.fetchStatus).toBe("fetching");
    pending[0]!.resolve(1);
    await vi.waitFor(() => { empty(qc); expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBe(1); });
  });

  it("every same-key refetch releases the marker", async () => {
    const pending = fixture(); const qc = client();
    const observer = source(writer).observe(qc);
    const stop = observer.subscribe(() => {});
    try {
      pending[0]!.resolve(0);
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true)); empty(qc);
      for (let index = 1; index < 4; index++) {
        const refetch = observer.refetch(); pending[index]!.resolve(index); await refetch; empty(qc);
        expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBe(index);
      }
    } finally { stop(); }
  });

  it("an older request finishing first cannot delete the newer marker", async () => {
    const pending = fixture(); const qc = client();
    const older = source(writer, "ws_a", "priority").fetch(qc);
    const newer = source(writer, "ws_a", "created_at").fetch(qc);
    pending[0]!.resolve(0); await older; await settle();
    expect(archivedTotalRequestStateForTesting(qc).count).toBe(1);
    pending[1]!.resolve(1); await newer; empty(qc);
    expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBe(1);
  });

  it.each(["success", "failure", "cancel"] as const)("newer %s removes authority instead of restoring the older marker", async (outcome) => {
    const pending = fixture(); const qc = client(); qc.setQueryData(issueKeys.archivedCount("ws_a"), 5);
    const older = source(writer, "ws_a", "priority").fetch(qc);
    const newerOptions = source(writer, "ws_a", "created_at");
    const newer = newerOptions.fetch(qc).catch(() => undefined);
    if (outcome === "cancel") await qc.cancelQueries({ queryKey: newerOptions.queryKey, exact: true });
    else if (outcome === "failure") pending[1]!.reject(new Error("newer failed"));
    else pending[1]!.resolve(1);
    await newer; empty(qc);
    pending[0]!.resolve(0); await older; await settle(); empty(qc);
    expect(qc.getQueryData(issueKeys.archivedCount("ws_a"))).toBe(outcome === "success" ? 1 : 5);
    if (outcome === "cancel") { pending[1]!.resolve(9); await settle(); empty(qc); }
  });
});
