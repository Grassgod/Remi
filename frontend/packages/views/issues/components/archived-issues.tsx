"use client";

import { useCallback, useEffect, useRef } from "react";
import { Accordion } from "@base-ui/react/accordion";
import { useQuery } from "@tanstack/react-query";
import { Archive, ChevronRight, EyeOff, Loader2, RotateCcw } from "lucide-react";
import type { Issue } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import {
  archivedIssueListOptions,
  type IssueSortParam,
} from "@multiremi/core/issues/queries";
import {
  useLoadMoreArchivedIssues,
  useRestoreIssue,
} from "@multiremi/core/issues/mutations";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { toast } from "sonner";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { BOARD_COL_WIDTH } from "./board-column";
import { InfiniteScrollSentinel } from "./infinite-scroll-sentinel";
import { StatusIcon } from "./status-icon";

export const ARCHIVED_ACCORDION_VALUE = "__archived__";

function ArchivedIssueRow({
  issue,
  variant,
  onRestore,
  restoring,
}: {
  issue: Issue;
  variant: "card" | "row";
  onRestore: (issue: Issue) => void;
  restoring: boolean;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const paths = useWorkspacePaths();
  const archivedAt = issue.archived_at ?? issue.updated_at;
  const restoreLabel = t(($) => $.archive.restore_issue);

  if (variant === "row") {
    return (
      <div className="group/archived-row flex min-h-10 items-center gap-3 border-b px-4 text-sm transition-colors hover:bg-accent/40">
        <StatusIcon status={issue.status} className="size-3.5" />
        <AppLink href={paths.issueDetail(issue.id)} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">{issue.identifier}</span>
          <span className="truncate font-medium">{issue.title}</span>
        </AppLink>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {t(($) => $.status[issue.status])}
        </span>
        <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
          {t(($) => $.archive.archived_ago, { time: timeAgo(archivedAt) })}
        </span>
        <RestoreButton
          label={restoreLabel}
          restoring={restoring}
          onClick={() => onRestore(issue)}
        />
      </div>
    );
  }

  return (
    <article className="rounded-md border bg-card p-3 transition-colors hover:bg-accent/25">
      <div className="flex min-w-0 items-start gap-2">
        <StatusIcon status={issue.status} className="mt-0.5 size-3.5" />
        <div className="min-w-0 flex-1">
          <AppLink href={paths.issueDetail(issue.id)} className="block truncate text-sm font-medium hover:underline">
            {issue.title}
          </AppLink>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{issue.identifier}</span>
            <span className="truncate">{t(($) => $.status[issue.status])}</span>
          </div>
        </div>
        <RestoreButton
          label={restoreLabel}
          restoring={restoring}
          onClick={() => onRestore(issue)}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(($) => $.archive.archived_ago, { time: timeAgo(archivedAt) })}
      </p>
    </article>
  );
}

function RestoreButton({
  label,
  restoring,
  onClick,
}: {
  label: string;
  restoring: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-full text-muted-foreground"
            aria-label={label}
            disabled={restoring}
            onClick={onClick}
          >
            {restoring ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function useArchivedIssueRows(enabled: boolean, sort?: IssueSortParam) {
  const wsId = useWorkspaceId();
  const query = useQuery({
    ...archivedIssueListOptions(wsId, sort),
    enabled,
  });
  const pagination = useLoadMoreArchivedIssues(sort);
  const restore = useRestoreIssue();
  const { t } = useT("issues");
  const handleRestore = useCallback((issue: Issue) => {
    restore.mutate(issue.id, {
      onSuccess: () => toast.success(t(($) => $.archive.restore_success)),
      onError: () => toast.error(t(($) => $.archive.restore_failed)),
    });
  }, [restore, t]);

  return {
    issues: query.data?.issues ?? [],
    isLoading: query.isLoading,
    isLoadingMore: pagination.isLoading,
    restoringId: restore.isPending ? restore.variables : null,
    handleRestore,
    loadMore: pagination.loadMore,
    hasMore: pagination.hasMore,
  };
}

export function ArchivedBoardColumn({
  total,
  sort,
  onHide,
}: {
  total: number;
  sort?: IssueSortParam;
  onHide: () => void;
}) {
  const { t } = useT("issues");
  const rows = useArchivedIssueRows(true, sort);
  const hideLabel = t(($) => $.archive.hide_column);
  const columnRef = useRef<HTMLElement>(null);

  useEffect(() => {
    columnRef.current?.scrollIntoView({ block: "nearest", inline: "end" });
  }, []);

  return (
    <section
      ref={columnRef}
      style={{ width: BOARD_COL_WIDTH }}
      className="flex shrink-0 flex-col rounded-lg bg-muted/40 p-2"
      aria-label={t(($) => $.archive.label)}
    >
      <div className="mb-2 flex h-7 items-center justify-between gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Archive className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{t(($) => $.archive.label)}</span>
          <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {total}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-muted-foreground"
                aria-label={hideLabel}
                onClick={onHide}
              >
                <EyeOff className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent>{hideLabel}</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-h-[200px] flex-1 rounded-md">
        <div className="absolute inset-0 space-y-2 overflow-y-auto rounded-md p-1">
          {rows.isLoading ? (
            <LoadingState />
          ) : rows.issues.length === 0 ? (
            <EmptyState />
          ) : (
            rows.issues.map((issue) => (
              <ArchivedIssueRow
                key={issue.id}
                issue={issue}
                variant="card"
                restoring={rows.restoringId === issue.id}
                onRestore={rows.handleRestore}
              />
            ))
          )}
          {rows.hasMore && (
            <InfiniteScrollSentinel onVisible={rows.loadMore} loading={rows.isLoadingMore} />
          )}
        </div>
      </div>
    </section>
  );
}

export function ArchivedListItem({
  expanded,
  total,
  sort,
}: {
  expanded: boolean;
  total: number;
  sort?: IssueSortParam;
}) {
  const { t } = useT("issues");
  const rows = useArchivedIssueRows(expanded, sort);

  return (
    <Accordion.Item value={ARCHIVED_ACCORDION_VALUE}>
      <Accordion.Header className="sticky top-0 z-10 flex h-10 items-center rounded-lg bg-muted transition-colors hover:bg-accent">
        <Accordion.Trigger className="group/trigger flex h-full flex-1 items-center gap-2 px-3 text-left outline-none">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/trigger:rotate-90" />
          <Archive className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{t(($) => $.archive.label)}</span>
          <span className="rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {total}
          </span>
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel>
        {rows.isLoading ? (
          <LoadingState />
        ) : rows.issues.length === 0 ? (
          <EmptyState />
        ) : (
          rows.issues.map((issue) => (
            <ArchivedIssueRow
              key={issue.id}
              issue={issue}
              variant="row"
              restoring={rows.restoringId === issue.id}
              onRestore={rows.handleRestore}
            />
          ))
        )}
        {rows.hasMore && (
          <InfiniteScrollSentinel onVisible={rows.loadMore} loading={rows.isLoadingMore} />
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function LoadingState() {
  const { t } = useT("issues");
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{t(($) => $.archive.loading)}</span>
    </div>
  );
}

function EmptyState() {
  const { t } = useT("issues");
  return <p className="py-8 text-center text-xs text-muted-foreground">{t(($) => $.archive.empty)}</p>;
}
