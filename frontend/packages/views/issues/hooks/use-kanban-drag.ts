"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Issue } from "@multiremi/core/types";
import type {
  IssueGrouping,
  SortField,
} from "@multiremi/core/issues/stores/view-store";
import type { BoardColumnGroup } from "../components/board-column";
import {
  buildColumns,
  computePosition,
  findColumn,
  getMoveUpdates,
  issueMatchesGroup,
  makeKanbanCollision,
  type DragMoveUpdates,
} from "../utils/drag-utils";

export interface KanbanDragOptions {
  /**
   * Flat list of every issue the view can drop onto — drives columns + map.
   * Must be referentially stable between renders (memoize it): the column
   * rebuild effect keys on it, and a fresh array every render loops.
   */
  issues: Issue[];
  /** Drop targets, in render order. Memoize for the same reason as `issues`. */
  groups: BoardColumnGroup[];
  /** How `issues` map onto `groups`. The list view is always "status". */
  grouping: IssueGrouping;
  /** Manual ordering (`position`) is the only sort that allows reordering. */
  sortBy: SortField;
  /** Omitted by read-only views; every drag then resets instead of moving. */
  onMoveIssue?: (
    issueId: string,
    updates: DragMoveUpdates,
    onSettled?: () => void
  ) => void;
}

export interface KanbanDrag {
  /** Column id → ordered issue ids. Local during a drag, TQ-driven between. */
  columns: Record<string, string[]>;
  /** Issue lookup, frozen for the duration of a drag. */
  issueMap: Map<string, Issue>;
  /** The card under the pointer, for the DragOverlay. */
  activeIssue: Issue | null;
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: CollisionDetection;
  /** Read by views that must suppress click-ish side effects mid-drag. */
  isDraggingRef: RefObject<boolean>;
  handleDragStart: (event: DragStartEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
}

/**
 * The kanban drag orchestration shared by the board and the list view.
 *
 * Both views drop issues into the same column model, so they need the same
 * five pieces of state (drag/settle latches, the locally-owned column map, the
 * rAF collision lock and the frozen issue map) and the same three dnd-kit
 * handlers. This used to be ~170 lines copy-pasted between the two files; the
 * only thing that ever differed was which issue array and grouping went into
 * `buildColumns`, which is now a parameter.
 */
export function useKanbanDrag({
  issues,
  groups,
  grouping,
  sortBy,
  onMoveIssue,
}: KanbanDragOptions): KanbanDrag {
  const groupIds = useMemo(
    () => new Set(groups.map((group) => group.id)),
    [groups],
  );
  const groupMap = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const collisionDetection = useMemo(
    () => makeKanbanCollision(groupIds),
    [groupIds],
  );

  // --- Drag state ---
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);
  const isDraggingRef = useRef(false);
  const isSettlingRef = useRef(false);
  const [settleVersion, setSettleVersion] = useState(0);

  // --- Local columns state ---
  // Between drags: follows TQ via useEffect.
  // During drag: local-only, driven by onDragOver/onDragEnd.
  const [columns, setColumns] = useState<Record<string, string[]>>(() =>
    buildColumns(issues, groups, grouping),
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    if (!isDraggingRef.current && !isSettlingRef.current) {
      setColumns(buildColumns(issues, groups, grouping));
    }
  }, [issues, groups, grouping, settleVersion]);

  // After a cross-column move, lock for one animation frame so dnd-kit's
  // collision detection can stabilize before processing the next move.
  // Without this, collision oscillates: A→B→A→B… until React bails out.
  const recentlyMovedRef = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      recentlyMovedRef.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [columns]);

  // --- Issue map ---
  // Frozen during drag so column/card props stay referentially stable even if
  // a TQ refetch lands mid-drag.
  const issueMap = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const issueMapRef = useRef(issueMap);
  if (!isDraggingRef.current && !isSettlingRef.current) {
    issueMapRef.current = issueMap;
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      isDraggingRef.current = true;
      const issue = issueMapRef.current.get(event.active.id as string) ?? null;
      setActiveIssue(issue);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || recentlyMovedRef.current) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      setColumns((prev) => {
        const activeCol = findColumn(prev, activeId, groupIds);
        const overCol = findColumn(prev, overId, groupIds);
        if (!activeCol || !overCol || activeCol === overCol) return prev;

        if (sortBy !== "position") return prev;

        recentlyMovedRef.current = true;
        const oldIds = prev[activeCol]!.filter((id) => id !== activeId);
        const newIds = [...prev[overCol]!];
        const overIndex = newIds.indexOf(overId);
        const insertIndex = overIndex >= 0 ? overIndex : newIds.length;
        newIds.splice(insertIndex, 0, activeId);
        return { ...prev, [activeCol]: oldIds, [overCol]: newIds };
      });
    },
    [groupIds, sortBy],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      isDraggingRef.current = false;
      setActiveIssue(null);

      const resetColumns = () =>
        setColumns(buildColumns(issues, groups, grouping));

      if (!over || !onMoveIssue) {
        resetColumns();
        return;
      }

      const activeId = active.id as string;
      const overId = over.id as string;

      const cols = columnsRef.current;
      const activeCol = findColumn(cols, activeId, groupIds);
      const overCol = findColumn(cols, overId, groupIds);
      if (!activeCol || !overCol) {
        resetColumns();
        return;
      }

      // Same-column reorder (manual sort only)
      let finalColumns = cols;
      if (activeCol === overCol && sortBy === "position") {
        const ids = cols[activeCol]!;
        const oldIndex = ids.indexOf(activeId);
        const newIndex = ids.indexOf(overId);
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const reordered = arrayMove(ids, oldIndex, newIndex);
          finalColumns = { ...cols, [activeCol]: reordered };
          setColumns(finalColumns);
        }
      }

      const finalCol = sortBy === "position"
        ? findColumn(finalColumns, activeId, groupIds)
        : overCol;
      if (!finalCol) {
        resetColumns();
        return;
      }
      const finalGroup = groupMap.get(finalCol);
      if (!finalGroup) {
        resetColumns();
        return;
      }

      const map = issueMapRef.current;

      if (sortBy !== "position") {
        // Cross-column: only update group (status/assignee), keep original position.
        const currentIssue = map.get(activeId);
        if (!currentIssue || issueMatchesGroup(currentIssue, finalGroup)) {
          resetColumns();
          return;
        }
        isSettlingRef.current = true;
        onMoveIssue(activeId, getMoveUpdates(finalGroup, currentIssue.position), () => {
          isSettlingRef.current = false;
          setSettleVersion((v) => v + 1);
        });
        return;
      }

      const finalIds = finalColumns[finalCol]!;
      const newPosition = computePosition(finalIds, activeId, map);
      const currentIssue = map.get(activeId);

      if (
        currentIssue &&
        issueMatchesGroup(currentIssue, finalGroup) &&
        currentIssue.position === newPosition
      ) {
        return;
      }

      isSettlingRef.current = true;
      onMoveIssue(activeId, getMoveUpdates(finalGroup, newPosition), () => {
        isSettlingRef.current = false;
      });
    },
    [issues, groups, grouping, onMoveIssue, groupIds, groupMap, sortBy],
  );

  return {
    columns,
    issueMap: issueMapRef.current,
    activeIssue,
    sensors,
    collisionDetection,
    isDraggingRef,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  };
}
