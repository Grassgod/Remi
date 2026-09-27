"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Play } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { issueDependenciesOptions, issueKeys } from "@multiremi/core/issues/queries";
import { useUpdateIssue } from "@multiremi/core/issues/mutations";
import { Button } from "@multiremi/ui/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import { IssueActivitySection } from "./issue-activity-section";
import { IssueDescriptionSection } from "./issue-description-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueSessionList } from "./issue-session-list";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useT } from "../../i18n";

interface IssueDetailMainProps {
  issue: Issue;
  issueId: string;
  parentIssue: Issue | null;
  breadcrumbProject: Project | null;
  actions: UseIssueActionsResult;
  onDone?: () => void;
  onDeletedNavigateTo?: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  isMobile: boolean;
  sessionSidebarOpen: boolean;
  onToggleSessionSidebar: () => void;
  sessions: IssueSessionSelection;
  members: MemberWithUser[];
  agents: Agent[];
  currentUserId?: string;
  canModerateComments: boolean;
  highlightCommentId?: string;
  onShowKeyResults: () => void;
  /** Callback ref for the scroll parent Virtuoso attaches to. */
  onScrollContainerRef: (el: HTMLDivElement | null) => void;
  scrollContainerEl: HTMLDivElement | null;
  canForceStart?: boolean;
}

/**
 * Left slot of the issue detail: header, session rail and the scrollable
 * document (description → sub-issues → activity).
 *
 * The rail lives outside the centered reading container so it fills the gutter
 * that layout leaves empty instead of eating the timeline's width, and it
 * stays put while the content scrolls. Every issue mounts it, at every width:
 * it is both the switcher and the only place a session can be created, so
 * hiding it on single-session issues hid the concept itself.
 */
export function IssueDetailMain({
  issue,
  issueId,
  parentIssue,
  breadcrumbProject,
  actions,
  onDone,
  onDeletedNavigateTo,
  sidebarOpen,
  onToggleSidebar,
  isMobile,
  sessionSidebarOpen,
  onToggleSessionSidebar,
  sessions,
  members,
  agents,
  currentUserId,
  canModerateComments,
  highlightCommentId,
  onShowKeyResults,
  onScrollContainerRef,
  scrollContainerEl,
  canForceStart = false,
}: IssueDetailMainProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const updateIssue = useUpdateIssue();
  const { data: dependencies = [] } = useQuery(issueDependenciesOptions(wsId, issueId));
  const waitingOn = dependencies
    .filter((dependency) => dependency.direction === "blocked_by" && dependency.depends_on_issue?.status !== "done")
    .map((dependency) => dependency.depends_on_issue?.identifier)
    .filter((key): key is string => !!key);
  const [forceStartOpen, setForceStartOpen] = useState(false);
  const [forceStartError, setForceStartError] = useState("");
  const forceStart = async () => {
    setForceStartError("");
    try {
      await updateIssue.mutateAsync({ id: issueId, status: "todo", force: true });
      await queryClient.invalidateQueries({ queryKey: issueKeys.dependencies(wsId, issueId) });
      setForceStartOpen(false);
    } catch (error) {
      setForceStartError(error instanceof Error ? error.message : t(($) => $.detail.force_start_failed));
    }
  };
  const handleSelectSession = (sessionId: string) => {
    sessions.select(sessionId);
    if (isMobile && sessionSidebarOpen) onToggleSessionSidebar();
  };

  const sessionList = (
    <IssueSessionList
      issueId={issueId}
      sessions={sessions.list}
      selectedSessionId={sessions.activeId}
      agents={agents}
      onSelectSession={handleSelectSession}
      className={isMobile ? "h-full w-full border-r-0 pb-8 pt-14 lg:w-full" : undefined}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <IssueDetailHeader
        issue={issue}
        parentIssue={parentIssue}
        breadcrumbProject={breadcrumbProject}
        onUpdateField={actions.updateField}
        onDone={onDone}
        onDeletedNavigateTo={onDeletedNavigateTo}
        isPinned={actions.isPinned}
        onTogglePin={actions.togglePin}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        sessionSidebarOpen={sessionSidebarOpen}
        onToggleSessionSidebar={onToggleSessionSidebar}
      />

      <div className="flex h-10 shrink-0 items-center border-b px-4" data-issue-notice-slot>
        {issue.status === "backlog" && waitingOn.length > 0 && (
          <div className="flex min-w-0 w-full items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
            <Clock3 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t(($) => $.detail.waiting_on, { keys: waitingOn.join("、") })}</span>
            {canForceStart && (
              <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1" onClick={() => setForceStartOpen(true)}>
                <Play className="size-3.5" />{t(($) => $.detail.force_start_action)}
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={forceStartOpen} onOpenChange={setForceStartOpen}>
        <AlertDialogContent className="max-w-[390px]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.detail.force_start_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.detail.force_start_body, { key: issue.identifier, keys: waitingOn.join("、") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {forceStartError && <p role="alert" className="text-sm text-destructive">{forceStartError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateIssue.isPending}>{t(($) => $.detail.force_cancel)}</AlertDialogCancel>
            <AlertDialogAction disabled={updateIssue.isPending} onClick={(event) => { event.preventDefault(); void forceStart(); }}>
              {updateIssue.isPending ? t(($) => $.detail.force_start_pending) : t(($) => $.detail.force_start_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex min-h-0 flex-1">
        {!isMobile && sessionSidebarOpen && sessionList}
        {isMobile && (
          <Sheet
            open={sessionSidebarOpen}
            onOpenChange={(open) => {
              if (open !== sessionSidebarOpen) onToggleSessionSidebar();
            }}
          >
            <SheetContent side="left" className="w-64 gap-0 p-0 sm:max-w-xs">
              {sessionList}
            </SheetContent>
          </Sheet>
        )}
        <div
          ref={onScrollContainerRef}
          data-tab-scroll-root
          data-perf-scroll="issue-detail"
          className="relative min-w-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
            <IssueDescriptionSection
              issue={issue}
              issueId={issueId}
              parentIssue={parentIssue}
              onUpdateField={actions.updateField}
              currentUserId={currentUserId}
            />

            <div className="my-8 border-t" />

            <IssueActivitySection
              issueId={issueId}
              projectId={issue.project_id}
              currentUserId={currentUserId}
              canModerateComments={canModerateComments}
              members={members}
              agents={agents}
              activeIssueSessionId={sessions.activeId}
              activeIssueSession={sessions.active}
              sessionsPending={sessions.pending}
              sessionsFetching={sessions.fetching}
              onRetrySessions={sessions.refetch}
              scrollContainerEl={scrollContainerEl}
              highlightCommentId={highlightCommentId}
              onShowKeyResults={onShowKeyResults}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
