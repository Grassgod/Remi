"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, CircleCheckBig, ClipboardCheck } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import {
  partitionReviewIssues,
  workbenchIssuesOptions,
} from "@multiremi/core/issues/workbench";
import { agentTaskSnapshotOptions } from "@multiremi/core/agents";
import type { Issue } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@multiremi/ui/components/ui/resizable";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";
import { IssueDetail } from "../../issues/components";
import { EmptyState } from "../../common/empty-state";
import { PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { WorkbenchListItem } from "./workbench-list-item";

function WorkbenchLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("common");
  return (
    <EmptyState
      className="flex-initial"
      variant="status"
      tone="destructive"
      icon={AlertCircle}
      title={t(($) => $.load_error.title)}
      description={t(($) => $.load_error.description)}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => $.load_error.retry)}
        </Button>
      }
    />
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-xs text-muted-foreground/60">{count}</span>
    </div>
  );
}

/**
 * The reviewer workbench (工作台): every issue currently waiting on a human,
 * split into "an agent is blocked on your reply" and "an agent finished —
 * review the result", with the in-progress list below for context. Selecting
 * an issue opens the full issue detail on the right so pending items can be
 * cleared one after another without leaving the page.
 */
export function WorkbenchPage() {
  const { t } = useT("workbench");
  const { t: tCommon } = useT("common");
  const { searchParams, replace } = useNavigation();
  const urlIssue = searchParams.get("issue") ?? "";
  const urlSession = searchParams.get("session") ?? "";
  const wsPaths = useWorkspacePaths();
  const wsId = useWorkspaceId();

  const [selectedId, setSelectedIdState] = useState(() => urlIssue);

  // Sync from URL when searchParams change (e.g. navigation)
  useEffect(() => {
    setSelectedIdState(urlIssue);
  }, [urlIssue]);

  const setSelectedId = useCallback(
    (id: string) => {
      setSelectedIdState(id);
      replace(id ? wsPaths.workbenchIssue(id) : wsPaths.workbench());
    },
    [replace, wsPaths],
  );

  const handleIssueSessionChange = useCallback(
    (sessionId: string) => {
      if (selectedId) replace(wsPaths.workbenchIssue(selectedId, sessionId));
    },
    [replace, selectedId, wsPaths],
  );

  const {
    data: reviewData,
    isLoading: loading,
    isError: loadFailed,
    refetch: refetchReview,
  } = useQuery(workbenchIssuesOptions(wsId, "in_review"));
  const { data: inProgressData } = useQuery(workbenchIssuesOptions(wsId, "in_progress"));
  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));

  const { awaitingInput, awaitingReview } = useMemo(
    () => partitionReviewIssues(reviewData?.issues ?? [], snapshot),
    [reviewData, snapshot],
  );
  const inProgress = inProgressData?.issues ?? [];

  // Ordered "needs me" list — drives auto-advance after an issue is resolved.
  const pending = useMemo(
    () => [...awaitingInput, ...awaitingReview],
    [awaitingInput, awaitingReview],
  );

  // After the selected issue is accepted or deleted, jump to the next pending
  // one (or the previous when resolving the last item) so review flows
  // through the queue without going back to the list each time.
  const advanceSelection = useCallback(() => {
    const idx = pending.findIndex((i) => i.id === selectedId);
    const next =
      idx >= 0 ? (pending[idx + 1] ?? pending[idx - 1]) : pending[0];
    setSelectedId(next && next.id !== selectedId ? next.id : "");
  }, [pending, selectedId, setSelectedId]);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "multimira_workbench_layout",
  });
  const isMobile = useIsMobile();

  // A failed fetch must not masquerade as an empty (all-clear) workbench.
  const allClear = !loadFailed && pending.length === 0 && inProgress.length === 0;

  const renderSection = (issues: Issue[], label: string, urgent?: boolean) =>
    issues.length > 0 && (
      <div>
        <SectionHeading label={label} count={issues.length} />
        {issues.map((issue) => (
          <WorkbenchListItem
            key={issue.id}
            issue={issue}
            isSelected={issue.id === selectedId}
            urgent={urgent}
            onClick={() => setSelectedId(issue.id)}
          />
        ))}
      </div>
    );

  const listHeader = (
    <PageHeader className="gap-2">
      <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
      <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
      {pending.length > 0 && (
        <span className="text-xs text-muted-foreground">{pending.length}</span>
      )}
    </PageHeader>
  );

  const listBody = loadFailed ? (
    <WorkbenchLoadError onRetry={() => void refetchReview()} />
  ) : allClear ? (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <CircleCheckBig className="mb-3 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm">{t(($) => $.page.all_clear_title)}</p>
      <p className="mt-1 text-xs text-muted-foreground/70">
        {t(($) => $.page.all_clear_description)}
      </p>
    </div>
  ) : (
    <div className="pb-4">
      {renderSection(awaitingInput, t(($) => $.sections.awaiting_input), true)}
      {renderSection(awaitingReview, t(($) => $.sections.awaiting_review))}
      {renderSection(inProgress, t(($) => $.sections.in_progress))}
    </div>
  );

  const detailContent = selectedId ? (
    <ErrorBoundary resetKeys={[selectedId]}>
      <IssueDetail
        key={selectedId}
        issueId={selectedId}
        layoutId="multimira_workbench_issue_detail_layout"
        initialIssueSessionId={
          urlIssue === selectedId ? urlSession || undefined : undefined
        }
        onIssueSessionChange={handleIssueSessionChange}
        onDelete={advanceSelection}
        onDone={advanceSelection}
      />
    </ErrorBoundary>
  ) : null;

  const listSkeleton = (
    <div className="flex-1 min-h-0 space-y-1 overflow-y-auto p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );

  // -- Mobile layout: list / detail toggle -----------------------------------

  if (isMobile) {
    if (selectedId) {
      return (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex h-12 shrink-0 items-center border-b px-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedId("")}
              className="gap-1.5 text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t(($) => $.page.back)}
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">{detailContent}</div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col min-h-0">
        {listHeader}
        {loading ? (
          listSkeleton
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">{listBody}</div>
        )}
      </div>
    );
  }

  // -- Desktop layout: resizable two-panel -----------------------------------

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="flex-1 min-h-0"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize={320}
        minSize={240}
        maxSize={480}
        groupResizeBehavior="preserve-pixel-size"
      >
        <div className="flex h-full flex-col border-r">
          {listHeader}
          {loading ? (
            listSkeleton
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">{listBody}</div>
          )}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" minSize="40%">
        <div className="flex h-full min-h-0 flex-col">
          {detailContent ?? (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
              <ClipboardCheck className="mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm">
                {loadFailed
                  ? tCommon(($) => $.load_error.title)
                  : allClear && !loading
                    ? t(($) => $.page.all_clear_title)
                    : t(($) => $.page.select_prompt)}
              </p>
            </div>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
