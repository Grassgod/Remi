/**
 * @vitest-environment jsdom
 *
 * MUL-472 item 5: the list marker must mean "these rows came from this page's
 * own resolved request". The probe resolves `--selectors auto` from the
 * marker's presence, so the negative cases matter as much as the positive one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LIST_PERF_MARKER_ATTRIBUTE,
  LIST_PERF_MARKER_VALUE,
  listPerfFresh,
  useListPerfMarker,
} from "./use-list-perf-marker";

function Probe({ status, isPlaceholderData }: {
  status: "pending" | "error" | "success";
  isPlaceholderData?: boolean;
}) {
  const marker = useListPerfMarker({ status, isPlaceholderData });
  return <div data-testid="list" {...marker} />;
}

describe("useListPerfMarker", () => {
  it("marks the list container once its own request resolved", () => {
    render(<Probe status="success" />);
    const list = screen.getByTestId("list");
    expect(list).toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
    expect(list.getAttribute(LIST_PERF_MARKER_ATTRIBUTE)).toBe(LIST_PERF_MARKER_VALUE);
  });

  it("leaves the container unmarked while the request is in flight", () => {
    render(<Probe status="pending" />);
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("leaves the container unmarked when the request failed", () => {
    render(<Probe status="error" />);
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("leaves the container unmarked while the rows are previous-data placeholders", () => {
    render(<Probe status="success" isPlaceholderData />);
    expect(screen.getByTestId("list")).not.toHaveAttribute(LIST_PERF_MARKER_ATTRIBUTE);
  });

  it("agrees with the pure freshness predicate", () => {
    expect(listPerfFresh({ status: "success" })).toBe(true);
    expect(listPerfFresh({ status: "success", isPlaceholderData: true })).toBe(false);
    expect(listPerfFresh({ status: "pending" })).toBe(false);
    expect(listPerfFresh({ status: "error" })).toBe(false);
  });
});
