import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Issue } from "@multiremi/core/types";
import { isOptionalPropSet, useOptionalProps } from "./use-optional-props";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "TES-1",
    title: "Implement authentication",
    description: "",
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    start_date: null,
    due_date: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as Issue;
}

describe("isOptionalPropSet", () => {
  it("treats priority 'none' as unset", () => {
    expect(isOptionalPropSet(issue(), "priority", 0)).toBe(false);
    expect(isOptionalPropSet(issue({ priority: "high" }), "priority", 0)).toBe(true);
  });

  it("reads the label count rather than the issue body", () => {
    expect(isOptionalPropSet(issue(), "labels", 0)).toBe(false);
    expect(isOptionalPropSet(issue(), "labels", 2)).toBe(true);
  });
});

describe("useOptionalProps", () => {
  it("seeds from whichever fields the issue already has", () => {
    const { result } = renderHook(() =>
      useOptionalProps(issue({ due_date: "2026-06-01", priority: "high" }), 0),
    );

    expect([...result.current.visible].sort()).toEqual(["due_date", "priority"]);
  });

  it("keeps a row visible after the user clears its value", () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Issue }) => useOptionalProps(current, 0),
      { initialProps: { current: issue({ due_date: "2026-06-01" }) } },
    );
    expect(result.current.visible.has("due_date")).toBe(true);

    rerender({ current: issue({ due_date: null }) });
    expect(result.current.visible.has("due_date")).toBe(true);
  });

  it("additively picks up a field set on the same issue", () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Issue }) => useOptionalProps(current, 0),
      { initialProps: { current: issue() } },
    );
    expect(result.current.visible.size).toBe(0);

    rerender({ current: issue({ priority: "urgent" }) });
    expect([...result.current.visible]).toEqual(["priority"]);
  });

  it("re-seeds from scratch when the issue itself changes", () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Issue }) => useOptionalProps(current, 0),
      { initialProps: { current: issue({ priority: "high" }) } },
    );
    expect(result.current.visible.has("priority")).toBe(true);

    rerender({ current: issue({ id: "issue-2", start_date: "2026-05-01" }) });
    expect([...result.current.visible]).toEqual(["start_date"]);
  });

  it("adding a property makes it visible and closes the picker popover", () => {
    const { result } = renderHook(() => useOptionalProps(issue(), 0));

    act(() => result.current.setPopoverOpen(true));
    expect(result.current.popoverOpen).toBe(true);

    act(() => result.current.add("labels"));
    expect(result.current.visible.has("labels")).toBe(true);
    expect(result.current.popoverOpen).toBe(false);
  });

  it("clears the auto-open flag after the picker has consumed it", () => {
    const { result } = renderHook(() => useOptionalProps(issue(), 0));

    act(() => result.current.add("due_date"));
    // The effect that resets it runs inside the same act() flush, so by the
    // time the caller can observe the hook again the one-shot is spent.
    expect(result.current.autoOpen).toBeNull();
  });
});
