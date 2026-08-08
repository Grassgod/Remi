"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multiremi/ui/components/ui/tooltip";
import { cn } from "@multiremi/ui/lib/utils";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { childIssuesOptions } from "@multiremi/core/issues/queries";
import { useIssueSelectionStore } from "@multiremi/core/issues/stores/selection-store";
import { useT } from "../../i18n";
import { BatchActionToolbar } from "./batch-action-toolbar";
import { ProgressRing } from "./progress-ring";
import { SubIssueRow } from "./sub-issue-row";

/**
 * Linear-style sub-issue list. Collapses to a lone "Add sub-issues" affordance
 * while the issue has no children.
 */
export function IssueSubIssuesSection({
  issueId,
  onCreateSubIssue,
}: {
  issueId: string;
  onCreateSubIssue: () => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data: childIssues = [] } = useQuery(childIssuesOptions(wsId, issueId));
  const [collapsed, setCollapsed] = useState(false);

  const selectedIds = useIssueSelectionStore((s) => s.selectedIds);
  const selectIds = useIssueSelectionStore((s) => s.select);
  const deselectIds = useIssueSelectionStore((s) => s.deselect);

  const childIssueIds = useMemo(() => childIssues.map((c) => c.id), [childIssues]);
  const childSelectedCount = childIssueIds.filter((cid) => selectedIds.has(cid)).length;
  const allChildrenSelected =
    childIssueIds.length > 0 && childSelectedCount === childIssueIds.length;
  const someChildrenSelected = childSelectedCount > 0;
  const handleToggleSelectAll = useCallback(() => {
    if (allChildrenSelected) deselectIds(childIssueIds);
    else selectIds(childIssueIds);
  }, [allChildrenSelected, childIssueIds, deselectIds, selectIds]);

  if (childIssues.length === 0) {
    return (
      <div className="mt-6">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={onCreateSubIssue}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{t(($) => $.detail.add_sub_issues)}</span>
        </button>
      </div>
    );
  }

  const doneCount = childIssues.filter((c) => c.status === "done").length;
  return (
    <div className="mt-10 group/sub-issues">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
          <span>{t(($) => $.detail.sub_issues_label)}</span>
        </button>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5">
          <ProgressRing done={doneCount} total={childIssues.length} size={11} />
          <span className="text-[11px] text-muted-foreground tabular-nums font-medium">
            {doneCount}/{childIssues.length}
          </span>
        </div>
        <input
          type="checkbox"
          checked={allChildrenSelected}
          ref={(el) => {
            if (el) el.indeterminate = someChildrenSelected && !allChildrenSelected;
          }}
          onChange={handleToggleSelectAll}
          aria-label={t(($) => $.detail.select_all_sub_issues_aria)}
          className={cn(
            "ml-1 cursor-pointer accent-primary transition-opacity",
            someChildrenSelected
              ? "opacity-100"
              : "opacity-0 group-hover/sub-issues:opacity-100 focus-visible:opacity-100",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                onClick={onCreateSubIssue}
                aria-label={t(($) => $.detail.add_sub_issue_aria)}
              >
                <Plus className="h-4 w-4" />
              </button>
            }
          />
          <TooltipContent side="bottom">{t(($) => $.detail.add_sub_issue_tooltip)}</TooltipContent>
        </Tooltip>
      </div>

      {/* Inline batch toolbar — appears next to the rows when
          selections exist, instead of as a far-away fixed bar. */}
      <BatchActionToolbar placement="inline" />

      {/* List */}
      {!collapsed && (
        <div className="overflow-hidden rounded-lg border bg-card/30 divide-y divide-border/60">
          {childIssues.map((child) => (
            <SubIssueRow key={child.id} child={child} />
          ))}
        </div>
      )}
    </div>
  );
}
