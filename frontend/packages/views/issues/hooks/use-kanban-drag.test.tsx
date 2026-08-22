import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import type { Issue, IssueStatus } from "@multiremi/core/types";
import type { BoardColumnGroup } from "../components/board-column";
import { statusGroupId } from "../utils/drag-utils";
import { useKanbanDrag } from "./use-kanban-drag";

function makeIssue(
  id: string,
  status: IssueStatus,
  position: number,
  overrides: Partial<Issue> = {}
): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: 1,
    identifier: `PROJ-${id}`,
    title: id,
    description: null,
    status,
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position,
    start_date: null,
    due_date: null,
    completed_at: null,
    archived_at: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// `issues` and `groups` must be referentially stable across renders — the
// column-rebuild effect keys on them. Both call sites memoize; the fixtures
// below are module-level for the same reason.
const STATUS_GROUPS: BoardColumnGroup[] = (
  ["todo", "in_progress"] as IssueStatus[]
).map((status) => ({
  id: statusGroupId(status),
  title: status,
  status,
  createData: { status },
}));

const TODO = statusGroupId("todo");
const IN_PROGRESS = statusGroupId("in_progress");

const THREE_ISSUES = [
  makeIssue("a", "todo", 100),
  makeIssue("b", "in_progress", 200),
  makeIssue("c", "todo", 300),
];
const TWO_ISSUES = [
  makeIssue("a", "todo", 100),
  makeIssue("b", "in_progress", 200),
];
const ONE_ISSUE = [makeIssue("a", "todo", 100)];

const ASSIGNEE_GROUPS: BoardColumnGroup[] = [
  {
    id: "assignee:member:user-1",
    title: "Ada",
    assigneeType: "member",
    assigneeId: "user-1",
    createData: { assignee_type: "member", assignee_id: "user-1" },
  },
  {
    id: "assignee:unassigned",
    title: "No assignee",
    assigneeType: null,
    assigneeId: null,
    createData: { assignee_type: null, assignee_id: null },
  },
];
const ASSIGNEE_ISSUES = [
  makeIssue("a", "todo", 100, {
    assignee_type: "member",
    assignee_id: "user-1",
  }),
  makeIssue("b", "todo", 200),
];

function dragStart(id: string): DragStartEvent {
  return { active: { id } } as unknown as DragStartEvent;
}

function dragOver(activeId: string, overId: string): DragOverEvent {
  return {
    active: { id: activeId },
    over: { id: overId },
  } as unknown as DragOverEvent;
}

function dragEnd(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  } as unknown as DragEndEvent;
}

describe("useKanbanDrag", () => {
  it("buckets issues into columns using the supplied grouping", () => {
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: THREE_ISSUES,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "position",
        onMoveIssue: vi.fn(),
      })
    );

    expect(result.current.columns).toEqual({
      [TODO]: ["a", "c"],
      [IN_PROGRESS]: ["b"],
    });
    expect(result.current.issueMap.get("b")?.status).toBe("in_progress");
    expect(result.current.activeIssue).toBeNull();
  });

  it("tracks the dragged issue for the overlay and clears it on drop", () => {
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: ONE_ISSUE,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "position",
        onMoveIssue: vi.fn(),
      })
    );

    act(() => result.current.handleDragStart(dragStart("a")));
    expect(result.current.activeIssue?.id).toBe("a");
    expect(result.current.isDraggingRef.current).toBe(true);

    act(() => result.current.handleDragEnd(dragEnd("a", TODO)));
    expect(result.current.activeIssue).toBeNull();
    expect(result.current.isDraggingRef.current).toBe(false);
  });

  it("moves the issue across columns and reports the new group + position", () => {
    const onMoveIssue = vi.fn();
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: TWO_ISSUES,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "position",
        onMoveIssue,
      })
    );

    act(() => result.current.handleDragStart(dragStart("a")));
    act(() => result.current.handleDragOver(dragOver("a", "b")));
    expect(result.current.columns).toEqual({
      [TODO]: [],
      [IN_PROGRESS]: ["a", "b"],
    });

    act(() => result.current.handleDragEnd(dragEnd("a", IN_PROGRESS)));
    expect(onMoveIssue).toHaveBeenCalledTimes(1);
    // Landed above "b" (position 200), so it gets one slot below it.
    expect(onMoveIssue).toHaveBeenCalledWith(
      "a",
      { status: "in_progress", position: 199 },
      expect.any(Function)
    );
  });

  it("keeps the original position when the view is not manually sorted", () => {
    const onMoveIssue = vi.fn();
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: TWO_ISSUES,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "priority",
        onMoveIssue,
      })
    );

    act(() => result.current.handleDragStart(dragStart("a")));
    // Non-manual sorts never reorder locally — the server order is the order.
    act(() => result.current.handleDragOver(dragOver("a", "b")));
    expect(result.current.columns[TODO]).toEqual(["a"]);

    act(() => result.current.handleDragEnd(dragEnd("a", IN_PROGRESS)));
    expect(onMoveIssue).toHaveBeenCalledWith(
      "a",
      { status: "in_progress", position: 100 },
      expect.any(Function)
    );
  });

  it("does not call onMoveIssue when the drop lands back where it started", () => {
    const onMoveIssue = vi.fn();
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: ONE_ISSUE,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "position",
        onMoveIssue,
      })
    );

    act(() => result.current.handleDragEnd(dragEnd("a", TODO)));
    expect(onMoveIssue).not.toHaveBeenCalled();
  });

  it("is inert for read-only views that pass no onMoveIssue", () => {
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: TWO_ISSUES,
        groups: STATUS_GROUPS,
        grouping: "status",
        sortBy: "position",
      })
    );

    act(() => result.current.handleDragStart(dragStart("a")));
    act(() => result.current.handleDragOver(dragOver("a", "b")));
    act(() => result.current.handleDragEnd(dragEnd("a", IN_PROGRESS)));

    // Columns snap back to the server-derived layout.
    expect(result.current.columns).toEqual({
      [TODO]: ["a"],
      [IN_PROGRESS]: ["b"],
    });
  });

  it("emits assignee updates when grouping by assignee", () => {
    const onMoveIssue = vi.fn();
    const { result } = renderHook(() =>
      useKanbanDrag({
        issues: ASSIGNEE_ISSUES,
        groups: ASSIGNEE_GROUPS,
        grouping: "assignee",
        sortBy: "priority",
        onMoveIssue,
      })
    );

    expect(result.current.columns).toEqual({
      "assignee:member:user-1": ["a"],
      "assignee:unassigned": ["b"],
    });

    act(() =>
      result.current.handleDragEnd(dragEnd("b", "assignee:member:user-1"))
    );
    expect(onMoveIssue).toHaveBeenCalledWith(
      "b",
      { assignee_type: "member", assignee_id: "user-1", position: 200 },
      expect.any(Function)
    );
  });
});
