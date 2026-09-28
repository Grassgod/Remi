import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import { myIssueListOptions } from "@multiremi/core/issues/queries";
import { resetAfterFirstScreenForTest } from "@multiremi/core/platform/use-after-first-screen";
import { NavigationProvider } from "../navigation";
import { useListPerfMarker } from "./use-list-perf-marker";

describe("list marker with real my-issues queries", () => {
  it("disappears for scope and sort requests, but persists for a client filter", async () => {
    resetAfterFirstScreenForTest();
    const pending: Array<() => void> = [];
    const listIssues = vi.fn(() => new Promise((resolve) => {
      pending.push(() => resolve({ issues: [], total: 0 }));
    }));
    setApiInstance({ listIssues } as unknown as ApiClient);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    function Probe({ scope, sorted, filter }: { scope: string; sorted: boolean; filter: string }) {
      const query = useQuery(myIssueListOptions(
        "ws-1", scope, scope === "assigned" ? { assignee_id: "user-1" } : { creator_id: "user-1" }, "user-1",
        { sort_by: sorted ? "priority" : "position" },
      ));
      const marker = useListPerfMarker(query);
      return <div data-testid="list" {...marker}>{filter}</div>;
    }
    const tree = (scope: string, sorted = false, filter = "all") => (
      <NavigationProvider value={{ pathname: "/acme/my-issues", searchParams: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), getShareableUrl: (path) => path }}>
        <QueryClientProvider client={client}>
          <Probe scope={scope} sorted={sorted} filter={filter} />
        </QueryClientProvider>
      </NavigationProvider>
    );
    const settle = async () => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      await act(async () => { pending.splice(0).forEach((resolve) => resolve()); });
      await waitFor(() => expect(screen.getByTestId("list")).toHaveAttribute("data-perf-scroll", "list"));
    };
    const { rerender, unmount } = render(tree("assigned"));
    expect(screen.getByTestId("list")).not.toHaveAttribute("data-perf-scroll");
    await settle();
    const initialRequests = listIssues.mock.calls.length;
    rerender(tree("created"));
    expect(screen.getByTestId("list")).not.toHaveAttribute("data-perf-scroll");
    await settle();
    expect(listIssues.mock.calls.length).toBeGreaterThan(initialRequests);
    const scopeRequests = listIssues.mock.calls.length;
    rerender(tree("created", true));
    expect(screen.getByTestId("list")).not.toHaveAttribute("data-perf-scroll");
    await settle();
    expect(listIssues.mock.calls.length).toBeGreaterThan(scopeRequests);
    const sortedRequests = listIssues.mock.calls.length;
    rerender(tree("created", true, "todo"));
    expect(screen.getByTestId("list")).toHaveAttribute("data-perf-scroll", "list");
    expect(listIssues).toHaveBeenCalledTimes(sortedRequests);
    unmount();
    client.clear();
    resetAfterFirstScreenForTest();
  });
});
