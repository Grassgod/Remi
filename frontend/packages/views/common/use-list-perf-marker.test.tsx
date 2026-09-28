/**
 * @vitest-environment jsdom
 *
 * MUL-472 item 5: the list marker must mean "these rows came from this page's
 * own resolved request". The probe resolves `--selectors auto` from the
 * marker's presence, so the negative cases matter as much as the positive one.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isRouteContentReadyForTest,
  resetAfterFirstScreenForTest,
  useRouteContentReady,
} from "@multiremi/core/platform/use-after-first-screen";
import { NavigationProvider } from "../navigation";
import {
  LIST_PERF_MARKER_ATTRIBUTE,
  LIST_PERF_MARKER_VALUE,
  listPerfFresh,
  useListPerfMarker,
} from "./use-list-perf-marker";

const navigation = {
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  push: () => {},
  replace: () => {},
  back: () => {},
  getShareableUrl: (path: string) => path,
};

function Probe({ status, isPlaceholderData }: {
  status: "pending" | "error" | "success";
  isPlaceholderData?: boolean;
}) {
  const marker = useListPerfMarker({ status, isPlaceholderData });
  const settled = status !== "pending" && !isPlaceholderData;
  useRouteContentReady(navigation.pathname, settled);
  return <div data-testid="list" {...marker} />;
}

function renderProbe(props: { status: "pending" | "error" | "success"; isPlaceholderData?: boolean }) {
  return render(
    <NavigationProvider value={navigation}>
      <Probe {...props} />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  resetAfterFirstScreenForTest();
});

describe("useListPerfMarker", () => {
  it("marks the list container once its own request resolved", () => {
    renderProbe({ status: "success" });
    const list = screen.getByTestId("list");
    expect(list).toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
    expect(list.getAttribute(LIST_PERF_MARKER_ATTRIBUTE)).toBe(LIST_PERF_MARKER_VALUE);
  });

  it("leaves the container unmarked while the request is in flight", () => {
    renderProbe({ status: "pending" });
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("leaves the container unmarked when the request failed", () => {
    renderProbe({ status: "error" });
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("leaves the container unmarked while the rows are previous-data placeholders", () => {
    renderProbe({ status: "success", isPlaceholderData: true });
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("publishes route readiness only once the rows are this request's rows", async () => {
    // The gate must not open while the list is still loading: that was QA's
    // finding (snapshot 660 ms / pins 102 ms before the first content row).
    resetAfterFirstScreenForTest();
    renderProbe({ status: "pending" });
    expect(isRouteContentReadyForTest(navigation.pathname)).toBe(false);

    resetAfterFirstScreenForTest();
    renderProbe({ status: "error" });
    // A failed request still counts as settled: a broken page must not hold the
    // deferred shell content back forever.
    await waitFor(() => expect(isRouteContentReadyForTest(navigation.pathname)).toBe(true));

    resetAfterFirstScreenForTest();
    renderProbe({ status: "success", isPlaceholderData: true });
    expect(isRouteContentReadyForTest(navigation.pathname)).toBe(false);

    resetAfterFirstScreenForTest();
    renderProbe({ status: "success" });
    await waitFor(() => expect(isRouteContentReadyForTest(navigation.pathname)).toBe(true));
  });

  it("drops the marker while a key-changing filter refetches, then restores it (MUL-472 item 5)", () => {
    // The corrected criterion: only filters that change the query key (e.g.
    // my-issues' scope and sort) must make the marker disappear while the new
    // data is in flight. Client-side filters never touch the query, so their
    // marker stays 1 -> 1.
    function KeyedProbe({ scope }: { scope: string }) {
      // `keepPreviousData` is what `myIssueListOptions` sets: the previous rows
      // stay on screen, and the marker must not certify them as the new answer.
      const isPlaceholderData = scope !== "assigned";
      const status = "success" as const;
      const marker = useListPerfMarker({ status, isPlaceholderData });
      return <div data-testid={`list-${scope}`} {...marker} />;
    }

    const { rerender } = render(
      <NavigationProvider value={navigation}>
        <KeyedProbe scope="assigned" />
      </NavigationProvider>,
    );
    expect(screen.getByTestId("list-assigned")).toHaveAttribute("data-perf-scroll", "list");

    // Scope switch: same component, new query key, placeholder rows in flight.
    rerender(
      <NavigationProvider value={navigation}>
        <KeyedProbe scope="created" />
      </NavigationProvider>,
    );
    expect(screen.getByTestId("list-created")).not.toHaveAttribute("data-perf-scroll");

    // New data arrived for the new key.
    rerender(
      <NavigationProvider value={navigation}>
        <KeyedProbe scope="assigned" />
      </NavigationProvider>,
    );
    expect(screen.getByTestId("list-assigned")).toHaveAttribute("data-perf-scroll", "list");
  });

  it("agrees with the pure freshness predicate", () => {
    expect(listPerfFresh({ status: "success" })).toBe(true);
    expect(listPerfFresh({ status: "success", isPlaceholderData: true })).toBe(false);
    expect(listPerfFresh({ status: "pending" })).toBe(false);
    expect(listPerfFresh({ status: "error" })).toBe(false);
  });
});
