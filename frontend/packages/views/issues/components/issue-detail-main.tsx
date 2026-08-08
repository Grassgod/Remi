"use client";

import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import { IssueActivitySection } from "./issue-activity-section";
import { IssueDescriptionSection } from "./issue-description-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueSessionList } from "./issue-session-list";
import { IssueSubIssuesSection } from "./issue-sub-issues-section";

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
        />

        <div className="flex min-h-0 flex-1">
        <IssueSessionList
          issueId={issueId}
          sessions={sessions.list}
          selectedSessionId={sessions.activeId}
          agents={agents}
          onSelectSession={sessions.select}
        />
        <div
          ref={onScrollContainerRef}
          data-tab-scroll-root
          className="relative min-w-0 flex-1 overflow-y-auto"
        >
        <div className="mx-auto w-full max-w-4xl px-8 py-8">
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
