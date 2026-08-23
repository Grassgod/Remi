"use client";

import { useMemo, memo } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { QueryKey } from "@tanstack/react-query";
import type { Issue, IssueAssigneeGroup, IssueStatus } from "@multiremi/core/types";
import { useLoadMoreByAssigneeGroup, useLoadMoreByStatus } from "@multiremi/core/issues/mutations";
import type { AssigneeGroupedIssuesFilter, IssueSortParam, MyIssuesFilter } from "@multiremi/core/issues/queries";
import { useViewStore } from "@multiremi/core/issues/stores/view-store-context";
import type { IssueGrouping } from "@multiremi/core/issues/stores/view-store";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { BoardColumn, BOARD_CARD_WIDTH, type BoardColumnGroup } from "./board-column";
import { BoardCardContent } from "./board-card";
import { HiddenColumnsPanel, HiddenColumnRow } from "./hidden-columns-panel";
import { ArchivedBoardColumn } from "./archived-issues";
import { InfiniteScrollSentinel } from "./infinite-scroll-sentinel";
import type { ChildProgress } from "./list-row";
import { useT } from "../../i18n";
import {
  type DragMoveUpdates,
  statusGroupId,
  assigneeGroupId,
} from "../utils/drag-utils";
import { useKanbanDrag } from "../hooks/use-kanban-drag";

function isStatusGroup(
  group: BoardColumnGroup,
): group is BoardColumnGroup & { status: IssueStatus } {
  return group.status !== undefined;
}

function buildGroups(
  issues: Issue[],
  visibleStatuses: IssueStatus[],
  grouping: IssueGrouping,
  getActorName: (type: string, id: string) => string,
  noAssigneeLabel: string,
): BoardColumnGroup[] {
  if (grouping === "status") {
    return visibleStatuses.map((status) => ({
      id: statusGroupId(status),
      title: status,
      status,
      createData: { status },
    }));
  }

  const groups = new Map<string, BoardColumnGroup>();
  for (const issue of issues) {
    const id = assigneeGroupId(issue.assignee_type, issue.assignee_id);
    if (groups.has(id)) continue;

    if (issue.assignee_type && issue.assignee_id) {
      groups.set(id, {
        id,
        title: getActorName(issue.assignee_type, issue.assignee_id),
        assigneeType: issue.assignee_type,
        assigneeId: issue.assignee_id,
        createData: {
          assignee_type: issue.assignee_type,
          assignee_id: issue.assignee_id,
        },
      });
      continue;
    }

    groups.set(id, {
      id,
      title: noAssigneeLabel,
      assigneeType: null,
      assigneeId: null,
      createData: {
        assignee_type: null,
        assignee_id: null,
      },
    });
  }

  const order: Record<string, number> = {
    member: 0,
    agent: 1,
    squad: 2,
    none: 3,
  };

  return Array.from(groups.values()).toSorted((a, b) => {
    const aOrder = order[a.assigneeType ?? "none"] ?? 99;
    const bOrder = order[b.assigneeType ?? "none"] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title);
  });
}

const EMPTY_PROGRESS_MAP = new Map<string, ChildProgress>();
const EMPTY_IDS: string[] = [];

export function BoardView({
  issues,
  assigneeGroups,
  assigneeGroupQueryKey,
  assigneeGroupFilter,
  visibleStatuses,
  hiddenStatuses,
  onMoveIssue,
  childProgressMap = EMPTY_PROGRESS_MAP,
  myIssuesScope,
  myIssuesFilter,
  sort,
  projectId,
  allowCreate = true,
  archivedTotal,
}: {
  issues: Issue[];
  assigneeGroups?: IssueAssigneeGroup[];
  assigneeGroupQueryKey?: QueryKey;
  assigneeGroupFilter?: AssigneeGroupedIssuesFilter;
  visibleStatuses: IssueStatus[];
  hiddenStatuses: IssueStatus[];
  onMoveIssue: (issueId: string, updates: DragMoveUpdates, onSettled?: () => void) => void;
  childProgressMap?: Map<string, ChildProgress>;
  /** When set, per-status load-more targets the scoped cache instead of the workspace one. */
  myIssuesScope?: string;
  myIssuesFilter?: MyIssuesFilter;
  /** Must match the sort the page queried with — embedded in the cache key. */
  sort?: IssueSortParam;
  /** When set, the per-column "+" pre-fills the project on the create form. */
  projectId?: string;
  allowCreate?: boolean;
  /** Defined only on the workspace Issues page, which owns the archive entry. */
  archivedTotal?: number;
}) {
  const { t } = useT("issues");
  const grouping = useViewStore((s) => s.grouping);
  const sortBy = useViewStore((s) => s.sortBy);
  const archivedColumnVisible = useViewStore((s) => s.archivedColumnVisible);
  const hideArchivedColumn = useViewStore((s) => s.hideArchivedColumn);
  const showArchivedColumn = useViewStore((s) => s.showArchivedColumn);
  const archiveEnabled = archivedTotal !== undefined;
  const sortFieldKey = sortBy === "created_at" ? "created" : sortBy;
  const sortLabel = sortBy !== "position"
    ? t(($) => $.board.ordered_by, { field: t(($) => $.display[`sort_${sortFieldKey}` as keyof typeof $.display]) })
    : null;
  const { getActorName } = useActorName();
  const myIssuesOpts = myIssuesScope
    ? { scope: myIssuesScope, filter: myIssuesFilter ?? {} }
    : undefined;
  const groupedIssues = useMemo(
    () =>
      grouping === "assignee" && assigneeGroups
        ? assigneeGroups.flatMap((group) => group.issues)
        : issues,
    [assigneeGroups, grouping, issues],
  );
  const hydratedAssigneeGroups = useMemo(() => {
    if (grouping !== "assignee" || !assigneeGroups) return undefined;
    const order: Record<string, number> = {
      member: 0,
      agent: 1,
      squad: 2,
      none: 3,
    };
    return assigneeGroups
      .map((group) => ({
        id: group.id,
        title:
          group.assignee_type && group.assignee_id
            ? getActorName(group.assignee_type, group.assignee_id)
            : t(($) => $.filters.no_assignee),
        assigneeType: group.assignee_type,
        assigneeId: group.assignee_id,
        totalCount: group.total,
        createData: {
          assignee_type: group.assignee_type,
          assignee_id: group.assignee_id,
        },
      }))
      .sort((a, b) => {
        const aOrder = order[a.assigneeType ?? "none"] ?? 99;
        const bOrder = order[b.assigneeType ?? "none"] ?? 99;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [assigneeGroups, getActorName, grouping, t]);
  const groups = useMemo(
    () =>
      hydratedAssigneeGroups ??
      buildGroups(
        issues,
        visibleStatuses,
        grouping,
        getActorName,
        t(($) => $.filters.no_assignee),
      ),
    [hydratedAssigneeGroups, issues, visibleStatuses, grouping, getActorName, t],
  );
  const {
    columns,
    issueMap,
    activeIssue,
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useKanbanDrag({
    issues: groupedIssues,
    groups,
    grouping,
    sortBy,
    onMoveIssue,
  });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-2">
        {groups.length === 0 ? (
          <div className="flex min-w-full flex-1 items-center justify-center text-sm text-muted-foreground">
            {t(($) => $.board.empty_grouping)}
          </div>
        ) : (
          groups.map((group) =>
            isStatusGroup(group) ? (
              <PaginatedBoardColumn
                key={group.id}
                group={group}
                issueIds={columns[group.id] ?? EMPTY_IDS}
                issueMap={issueMap}
                childProgressMap={childProgressMap}
                myIssuesOpts={myIssuesOpts}
                sort={sort}
                projectId={projectId}
                allowCreate={allowCreate}
                sortLabel={sortLabel}
              />
            ) : (
              assigneeGroupQueryKey && assigneeGroupFilter ? (
                <PaginatedAssigneeBoardColumn
                  key={group.id}
                  group={group}
                  issueIds={columns[group.id] ?? EMPTY_IDS}
                  issueMap={issueMap}
                  childProgressMap={childProgressMap}
                  queryKey={assigneeGroupQueryKey}
                  filter={assigneeGroupFilter}
                  sort={sort}
                  projectId={projectId}
                  allowCreate={allowCreate}
                  sortLabel={sortLabel}
                />
              ) : (
                <BoardColumn
                  key={group.id}
                  group={group}
                  issueIds={columns[group.id] ?? EMPTY_IDS}
                  issueMap={issueMap}
                  childProgressMap={childProgressMap}
                  projectId={projectId}
                  allowCreate={allowCreate}
                  totalCount={group.totalCount}
                  sortLabel={sortLabel}
                />
              )
            ),
          )
        )}

        {archiveEnabled && archivedColumnVisible && (
          <ArchivedBoardColumn
            total={archivedTotal}
            sort={sort}
            onHide={hideArchivedColumn}
          />
        )}

        {((grouping === "status" && hiddenStatuses.length > 0) ||
          (archiveEnabled && !archivedColumnVisible)) && (
          <BoardHiddenColumnsPanel
            hiddenStatuses={grouping === "status" ? hiddenStatuses : []}
            myIssuesOpts={myIssuesOpts}
            sort={sort}
            archivedTotal={archivedTotal}
            onShowArchived={archiveEnabled && !archivedColumnVisible ? showArchivedColumn : undefined}
          />
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIssue ? (
          <div style={{ width: BOARD_CARD_WIDTH }} className="rotate-1 cursor-grabbing opacity-90 shadow-lg shadow-black/10">
            <BoardCardContent issue={activeIssue} childProgress={childProgressMap.get(activeIssue.id)} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const PaginatedAssigneeBoardColumn = memo(function PaginatedAssigneeBoardColumn({
  group,
  issueIds,
  issueMap,
  childProgressMap,
  queryKey,
  filter,
  sort,
  projectId,
  allowCreate,
  sortLabel,
}: {
  group: BoardColumnGroup;
  issueIds: string[];
  issueMap: Map<string, Issue>;
  childProgressMap?: Map<string, ChildProgress>;
  queryKey: QueryKey;
  filter: AssigneeGroupedIssuesFilter;
  sort?: IssueSortParam;
  projectId?: string;
  allowCreate?: boolean;
  sortLabel?: string | null;
}) {
  const { loadMore, hasMore, isLoading, total } = useLoadMoreByAssigneeGroup(
    {
      id: group.id,
      assignee_type: group.assigneeType ?? null,
      assignee_id: group.assigneeId ?? null,
    },
    queryKey,
    filter,
    sort,
  );
  return (
    <BoardColumn
      group={group}
      issueIds={issueIds}
      issueMap={issueMap}
      childProgressMap={childProgressMap}
      totalCount={total}
      projectId={projectId}
      allowCreate={allowCreate}
      sortLabel={sortLabel}
      footer={
        hasMore ? (
          <InfiniteScrollSentinel onVisible={loadMore} loading={isLoading} />
        ) : undefined
      }
    />
  );
});

const PaginatedBoardColumn = memo(function PaginatedBoardColumn({
  group,
  issueIds,
  issueMap,
  childProgressMap,
  myIssuesOpts,
  sort,
  projectId,
  allowCreate,
  sortLabel,
}: {
  group: BoardColumnGroup & { status: IssueStatus };
  issueIds: string[];
  issueMap: Map<string, Issue>;
  childProgressMap?: Map<string, ChildProgress>;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  sort?: IssueSortParam;
  projectId?: string;
  allowCreate?: boolean;
  sortLabel?: string | null;
}) {
  const { loadMore, hasMore, isLoading, total } = useLoadMoreByStatus(
    group.status,
    myIssuesOpts,
    sort,
  );
  return (
    <BoardColumn
      group={group}
      issueIds={issueIds}
      issueMap={issueMap}
      childProgressMap={childProgressMap}
      totalCount={total}
      projectId={projectId}
      allowCreate={allowCreate}
      sortLabel={sortLabel}
      footer={
        hasMore ? (
          <InfiniteScrollSentinel onVisible={loadMore} loading={isLoading} />
        ) : undefined
      }
    />
  );
});

/**
 * Board-view-specific row that pulls the server-aggregated total from
 * `useLoadMoreByStatus` and hands it to the shared {@link HiddenColumnRow}.
 * Lives here (not in `hidden-columns-panel.tsx`) so the shared panel stays
 * free of `useLoadMoreByStatus` / `myIssuesOpts` coupling — the swimlane
 * uses an in-memory total instead.
 */
function BoardHiddenColumnRow({
  status,
  myIssuesOpts,
  sort,
}: {
  status: IssueStatus;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  sort?: IssueSortParam;
}) {
  const { total } = useLoadMoreByStatus(status, myIssuesOpts, sort);
  return <HiddenColumnRow status={status} total={total} />;
}

function BoardHiddenColumnsPanel({
  hiddenStatuses,
  myIssuesOpts,
  sort,
  archivedTotal,
  onShowArchived,
}: {
  hiddenStatuses: IssueStatus[];
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  sort?: IssueSortParam;
  archivedTotal?: number;
  onShowArchived?: () => void;
}) {
  return (
    <HiddenColumnsPanel
      hiddenStatuses={hiddenStatuses}
      archivedTotal={archivedTotal}
      onShowArchived={onShowArchived}
      renderRow={(status) => (
        <BoardHiddenColumnRow
          key={status}
          status={status}
          myIssuesOpts={myIssuesOpts}
          sort={sort}
        />
      )}
    />
  );
}
