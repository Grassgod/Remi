"use client";

import { useCallback, useMemo, useState } from "react";
import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import {
  useAnchoredReveal,
  type RevealAnchor,
} from "../../common/use-anchored-reveal";
import { useStickToBottom } from "../../common/use-stick-to-bottom";
import { IssueActivitySection } from "./issue-activity-section";
import { IssueDescriptionSection } from "./issue-description-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueSessionList } from "./issue-session-list";
import { IssueSubIssuesSection } from "./issue-sub-issues-section";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";

/** Gate (i) and gate (ii) as the activity section reports them. */
export interface RevealGates {
  dataReady: boolean;
  layoutSettled: boolean;
}

/**
 * The deep-link path renders every comment flat and mounts all of them in one
 * commit, so a 250-comment fixture can exceed the default budget on a loaded CI
 * runner. Waiting longer is better than publishing `ready-forced`, which the
 * recorders count as a failure. MUL-393 windows this path and the exception
 * goes away.
 */
const DEEP_LINK_REVEAL_BUDGET_MS = 1_500;

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

  // The content element the reveal hook hides and measures. It has to be the
  // scroll root's direct child so `scrollHeight` describes the whole document
  // the user is about to land in.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const [gates, setGates] = useState<RevealGates>({ dataReady: false, layoutSettled: false });

  const anchor = useMemo<RevealAnchor>(
    () => highlightCommentId
      ? { kind: "element", id: `comment-${highlightCommentId}` }
      : { kind: "bottom" },
    [highlightCommentId],
  );

  // Re-arms the reveal on an issue/session/deep-link change. `activeId` is the
  // resolved session, so a fresh page mount starts it empty and gets a fresh
  // cycle once the session list answers.
  const resetKey = `${issueId}:${sessions.activeId}:${highlightCommentId ?? ""}`;

  const reveal = useAnchoredReveal({
    scrollEl: scrollContainerEl,
    contentEl,
    resetKey,
    dataReady: gates.dataReady,
    anchor,
    layoutSettled: gates.layoutSettled,
    // No replica on this page, so the freshness attribute stays absent and the
    // recorder falls back to `data-perf-state` alone.
    fresh: undefined,
    budgetMs: highlightCommentId ? DEEP_LINK_REVEAL_BUDGET_MS : undefined,
  });

  const stick = useStickToBottom({
    scrollEl: scrollContainerEl,
    contentEl,
    mode: anchor.kind === "bottom" ? { kind: "bottom" } : { kind: "element", id: anchor.id },
    enabled: reveal.revealed,
    // A deep link lands on a comment, not on the end of the stream: pinning
    // there would fight the user's own scroll from the first frame.
    initialState: highlightCommentId ? "released" : "pinned",
  });

  // Stable identity: the activity section feeds this to Virtuoso and the
  // reveal hook subscribes to the gate value, so a fresh object every render
  // would re-run both.
  const handleRevealGatesChange = useCallback((next: RevealGates) => {
    setGates((prev) => (
      prev.dataReady === next.dataReady && prev.layoutSettled === next.layoutSettled
        ? prev
        : next
    ));
  }, []);

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
          data-perf-scroll="issue-detail"
          className="relative min-w-0 flex-1 overflow-y-auto"
        >
          {/* The reveal hook hides this subtree until its gates hold, so the
              first frame that shows real content is already at the final
              position. It keeps `visibility: hidden` rather than unmounting
              because the hook measures real heights to know where "final" is.

              `relative` is what the overlay below positions against: it has to
              span the whole scrollable height, not just the first viewport, or
              it would scroll out of sight while the hook is still positioning.

              The overlay sits *inside* the hidden subtree on purpose. It
              overrides `visibility` on itself, which a descendant may do, and
              being absolutely positioned it contributes nothing to the height
              the hook measures. Skeleton rows carry `data-slot="skeleton"`, so
              both probes refuse to call the page ready while it is up; the hook
              removes it in the same frame it reveals the content. */}
          <div
            ref={setContentEl}
            className="relative mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8"
          >
            {reveal.state === "pending" && (
              <div
                data-slot="skeleton"
                className="visible absolute inset-0 z-10 flex flex-col justify-end gap-3 bg-background"
              >
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-3 p-4">
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-4/5" />
                    </div>
                  </div>
                ))}
              </div>
            )}
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
              onRevealGatesChange={handleRevealGatesChange}
              onPinToBottom={stick.pin}
              stickState={stick.state}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
