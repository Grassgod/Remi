"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock3, Play } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { issueKeys } from "@multiremi/core/issues/queries";
import { useUpdateIssue } from "@multiremi/core/issues/mutations";
import { Button } from "@multiremi/ui/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import { IssueActivitySection } from "./issue-activity-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueDecisionPanel } from "./issue-decision-panel";
import { IssueSessionList } from "./issue-session-list";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS, useRouteContentReady } from "@multiremi/core/platform/use-after-first-screen";

/** Gate (i) and gate (ii) as the activity section reports them. */
export interface RevealGates {
  dataReady: boolean;
  layoutSettled: boolean;
}

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
  getActorName: (type: string, id: string) => string;
  highlightCommentId?: string;
  initialLog?: IssueLogBootstrap;
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
  getActorName,
  highlightCommentId,
  initialLog,
  onShowKeyResults,
  onScrollContainerRef,
  scrollContainerEl,
  canForceStart = false,
}: IssueDetailMainProps) {
  const { t } = useT("issues");
  const { pathname } = useNavigation();
  const readyKey = `${issueId}:${sessions.activeId}:${highlightCommentId ?? ""}`;
  const [readiness, setReadiness] = useState({ key: readyKey, ready: false });
  // Reset before children commit, including when returning to a previously ready key.
  if (readiness.key !== readyKey) setReadiness({ key: readyKey, ready: false });
  useRouteContentReady(pathname, readiness.key === readyKey && readiness.ready);
  useEffect(() => {
    if (readiness.ready) return;
    const timer = setTimeout(() => {
      setReadiness(current => current.key === readyKey && !current.ready ? { ...current, ready: true } : current);
    }, AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [readyKey, readiness.ready]);
  const onContentReady = useCallback(() => {
    setReadiness(current => current.key === readyKey && !current.ready ? { ...current, ready: true } : current);
  }, [readyKey]);
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const updateIssue = useUpdateIssue();
  const waitingOn = issue.blocked_by ?? [];
  const showDecisions = (issue.pending_decision_count ?? 0) > 0;
  const showWaiting = !showDecisions && issue.parent_issue_id !== null
    && issue.status === "backlog" && waitingOn.length > 0;
  const [forceStartOpen, setForceStartOpen] = useState(false);
  const [forceStartError, setForceStartError] = useState("");
  const getDecisionActorName = useCallback((type: string, id: string) => {
    if (type === "member") {
      return members.find((member) => member.id === id || member.user_id === id)?.name
        ?? getActorName(type, id);
    }
    return getActorName(type, id);
  }, [getActorName, members]);
  const forceStart = async () => {
    setForceStartError("");
    try {
      await updateIssue.mutateAsync({ id: issueId, status: "todo", force: true });
      await queryClient.invalidateQueries({ queryKey: issueKeys.dependencies(wsId, issueId) });
      await queryClient.invalidateQueries({ queryKey: issueKeys.detail(wsId, issueId) });
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

      {(showDecisions || showWaiting) && <div
        className={`flex h-10 shrink-0 items-center border-b px-4 ${
          showDecisions
            ? "bg-blue-50/70 dark:bg-blue-950/20"
            : ""
        }`}
        data-issue-notice-slot
      >
        {showDecisions && (
          <IssueDecisionPanel
            issueId={issueId}
            pendingCount={issue.pending_decision_count ?? 0}
            canAnswer={canForceStart}
            getActorName={getDecisionActorName}
          />
        )}
        {showWaiting && (
          <div className="flex min-w-0 w-full items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
            <Clock3 className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col leading-4">
              <span className="truncate">{t(($) => $.detail.waiting_on, { keys: waitingOn.join(", ") })}</span>
              {canForceStart && (
                <span className="truncate text-[11px] text-muted-foreground">
                  {t(($) => $.detail.waiting_on_start_hint)}
                </span>
              )}
            </span>
            {canForceStart && (
              <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 whitespace-nowrap" onClick={() => setForceStartOpen(true)}>
                <Play className="size-3.5" />{t(($) => $.detail.force_start_action)}
              </Button>
            )}
          </div>
        )}
      </div>}

      <AlertDialog open={forceStartOpen} onOpenChange={setForceStartOpen}>
        <AlertDialogContent className="max-w-[390px]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.detail.force_start_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.detail.force_start_body, { key: issue.identifier, keys: waitingOn.join(", ") })}
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <IssueActivitySection
              onContentReady={onContentReady}
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
              initialLog={initialLog}
              onShowKeyResults={onShowKeyResults}
              onScrollRoot={onScrollContainerRef}
            />
        </div>
      </div>
    </div>
  );
}
