"use client";

import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import { IssueActivitySection } from "./issue-activity-section";
import { IssueDescriptionSection } from "./issue-description-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueSessionList } from "./issue-session-list";
import { IssueSubIssuesSection } from "./issue-sub-issues-section";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";

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
}: IssueDetailMainProps) {
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

            <IssueSubIssuesSection
              issueId={issueId}
              onCreateSubIssue={actions.openCreateSubIssue}
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
