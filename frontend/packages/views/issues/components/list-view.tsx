"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Accordion } from "@base-ui/react/accordion";
import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multiremi/ui/components/ui/tooltip";
import { Button } from "@multiremi/ui/components/ui/button";
import type { Issue, IssueStatus } from "@multiremi/core/types";
import { useLoadMoreByStatus } from "@multiremi/core/issues/mutations";
import type { IssueSortParam, MyIssuesFilter } from "@multiremi/core/issues/queries";
import { useModalStore } from "@multiremi/core/modals";
import { useViewStore } from "@multiremi/core/issues/stores/view-store-context";
import { useIssueSelectionStore } from "@multiremi/core/issues/stores/selection-store";
import { StatusHeading } from "./status-heading";
import { ListRow, DraggableListRow, type ChildProgress } from "./list-row";
import { InfiniteScrollSentinel } from "./infinite-scroll-sentinel";
import { useT } from "../../i18n";
import { type DragMoveUpdates, statusGroupId } from "../utils/drag-utils";
import { useKanbanDrag } from "../hooks/use-kanban-drag";
import type { BoardColumnGroup } from "./board-column";
import { ARCHIVED_ACCORDION_VALUE, ArchivedListItem } from "./archived-issues";

const EMPTY_PROGRESS_MAP = new Map<string, ChildProgress>();
const EMPTY_IDS: string[] = [];

function buildListGroups(visibleStatuses: IssueStatus[]): BoardColumnGroup[] {
  return visibleStatuses.map((status) => ({
    id: statusGroupId(status),
    title: status,
    status,
    createData: { status },
  }));
}

export function ListView({
  issues,
  visibleStatuses,
  childProgressMap = EMPTY_PROGRESS_MAP,
  myIssuesScope,
  myIssuesFilter,
  projectId,
  allowCreate = true,
  onMoveIssue,
  sort,
  archivedTotal,
}: {
  issues: Issue[];
  visibleStatuses: IssueStatus[];
  childProgressMap?: Map<string, ChildProgress>;
  myIssuesScope?: string;
  myIssuesFilter?: MyIssuesFilter;
  projectId?: string;
  allowCreate?: boolean;
  onMoveIssue?: (issueId: string, updates: DragMoveUpdates, onSettled?: () => void) => void;
  sort?: IssueSortParam;
  /** Defined only on the workspace Issues page, which owns the archive entry. */
  archivedTotal?: number;
}) {
  const listCollapsedStatuses = useViewStore(
    (s) => s.listCollapsedStatuses
  );
  const toggleListCollapsed = useViewStore(
    (s) => s.toggleListCollapsed
  );
  const sortBy = useViewStore((s) => s.sortBy);
  const { t } = useT("issues");
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const sortFieldKey = sortBy === "created_at" ? "created" : sortBy;
  const sortLabel = sortBy !== "position"
    ? t(($) => $.board.ordered_by, { field: t(($) => $.display[`sort_${sortFieldKey}` as keyof typeof $.display]) })
    : null;

  const expandedStatuses = useMemo(
    () =>
      visibleStatuses.filter(
        (s) => !listCollapsedStatuses.includes(s)
      ),
    [visibleStatuses, listCollapsedStatuses]
  );

  const myIssuesOpts = myIssuesScope
    ? { scope: myIssuesScope, filter: myIssuesFilter ?? {} }
    : undefined;

  const dragEnabled = !!onMoveIssue;

  const groups = useMemo(
    () => buildListGroups(visibleStatuses),
    [visibleStatuses],
  );
  const {
    columns,
    issueMap,
    activeIssue,
    sensors,
    collisionDetection,
    isDraggingRef,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useKanbanDrag({
    issues,
    groups,
    grouping: "status",
    sortBy,
    onMoveIssue,
  });

  const content = (
    <Accordion.Root
      multiple
      className="space-y-1"
      value={[
        ...expandedStatuses,
        ...(archivedExpanded ? [ARCHIVED_ACCORDION_VALUE] : []),
      ]}
      onValueChange={(value: string[]) => {
        if (isDraggingRef.current) return;
        for (const status of visibleStatuses) {
          const wasExpanded = expandedStatuses.includes(status);
          const isExpanded = value.includes(status);
          if (wasExpanded !== isExpanded) {
            toggleListCollapsed(status as IssueStatus);
          }
        }
        if (archivedTotal !== undefined) {
          setArchivedExpanded(value.includes(ARCHIVED_ACCORDION_VALUE));
        }
      }}
    >
      {visibleStatuses.map((status) => {
        const isExpanded = expandedStatuses.includes(status);
        return (
          <StatusAccordionItem
            key={status}
            status={status}
            issueIds={columns[statusGroupId(status)] ?? EMPTY_IDS}
            issueMap={issueMap}
            childProgressMap={childProgressMap}
            myIssuesOpts={myIssuesOpts}
            projectId={projectId}
            allowCreate={allowCreate}
            dragEnabled={dragEnabled}
            isExpanded={isExpanded}
            sortLabel={sortLabel}
            sort={sort}
          />
        );
      })}
      {archivedTotal !== undefined && (
        <ArchivedListItem
          expanded={archivedExpanded}
          total={archivedTotal}
          sort={sort}
        />
      )}
    </Accordion.Root>
  );

  if (!dragEnabled) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-0">
        {content}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-0">
        {content}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIssue ? (
          <div className="max-w-2xl rotate-1 cursor-grabbing opacity-90 shadow-lg shadow-black/10 rounded-md border border-border bg-card px-4 py-2">
            <span className="text-xs text-muted-foreground mr-2">{activeIssue.identifier}</span>
            <span className="text-sm">{activeIssue.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function StatusAccordionItem({
  status,
  issueIds,
  issueMap,
  childProgressMap,
  myIssuesOpts,
  projectId,
  allowCreate,
  dragEnabled,
  isExpanded,
  sortLabel,
  sort,
}: {
  status: IssueStatus;
  issueIds: string[];
  issueMap: Map<string, Issue>;
  childProgressMap: Map<string, ChildProgress>;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  projectId?: string;
  allowCreate: boolean;
  dragEnabled: boolean;
  isExpanded: boolean;
  sortLabel: string | null;
  sort?: IssueSortParam;
}) {
  const { t } = useT("issues");
  const selectedIds = useIssueSelectionStore((s) => s.selectedIds);
  const select = useIssueSelectionStore((s) => s.select);
  const deselect = useIssueSelectionStore((s) => s.deselect);
  const { loadMore, hasMore, isLoading, total } = useLoadMoreByStatus(
    status,
    myIssuesOpts,
    sort,
  );

  const issues = useMemo(
    () => issueIds.flatMap((id) => {
      const issue = issueMap.get(id);
      return issue ? [issue] : [];
    }),
    [issueIds, issueMap],
  );

  const selectedCount = issueIds.filter((id) => selectedIds.has(id)).length;
  const allSelected = issues.length > 0 && selectedCount === issues.length;
  const someSelected = selectedCount > 0;

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: statusGroupId(status),
    disabled: !dragEnabled,
  });

  const disableSorting = !!sortLabel;

  return (
    <Accordion.Item value={status} ref={dragEnabled ? setDroppableRef : undefined}>
      <Accordion.Header
        className={`group/header sticky top-0 z-10 flex h-10 items-center rounded-lg bg-muted transition-colors hover:bg-accent ${
          isOver && !isExpanded
            ? "ring-2 ring-brand/25 bg-accent/15"
            : ""
        }`}
      >
        <div className="pl-3 flex items-center">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={() => {
              if (allSelected) {
                deselect(issueIds);
              } else {
                select(issueIds);
              }
            }}
            className="cursor-pointer accent-primary"
          />
        </div>
        <Accordion.Trigger className="group/trigger flex flex-1 items-center gap-2 px-2 h-full text-left outline-none cursor-pointer">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/trigger:rotate-90" />
          <StatusHeading status={status} count={total} />
        </Accordion.Trigger>
        {allowCreate && <div className="pr-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground opacity-0 group-hover/header:opacity-100 transition-opacity"
                  onClick={() =>
                    useModalStore
                      .getState()
                      .open("create-issue", { status, ...(projectId ? { project_id: projectId } : {}) })
                  }
                />
              }
            >
              <Plus className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t(($) => $.list.add_issue_tooltip)}</TooltipContent>
          </Tooltip>
        </div>}
      </Accordion.Header>
      <Accordion.Panel>
        {issues.length > 0 ? (
          dragEnabled ? (
            <SortableContext items={issueIds} strategy={verticalListSortingStrategy}>
              {issues.map((issue) => (
                <DraggableListRow
                  key={issue.id}
                  issue={issue}
                  childProgress={childProgressMap.get(issue.id)}
                  disableSorting={disableSorting}
                />
              ))}
              {hasMore && (
                <InfiniteScrollSentinel onVisible={loadMore} loading={isLoading} />
              )}
            </SortableContext>
          ) : (
            <>
              {issues.map((issue) => (
                <ListRow key={issue.id} issue={issue} childProgress={childProgressMap.get(issue.id)} />
              ))}
              {hasMore && (
                <InfiniteScrollSentinel onVisible={loadMore} loading={isLoading} />
              )}
            </>
          )
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t(($) => $.list.empty_status)}
          </p>
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}
