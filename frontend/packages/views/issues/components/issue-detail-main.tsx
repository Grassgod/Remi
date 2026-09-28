"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Play } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { issueDecisionsOptions, issueDependenciesOptions, issueKeys } from "@multiremi/core/issues/queries";
import { useUpdateIssue } from "@multiremi/core/issues/mutations";
import { Button } from "@multiremi/ui/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import type { Agent, Issue, MemberWithUser, Project } from "@multiremi/core/types";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";
import {
  useAnchoredReveal,
  type RevealAnchor,
} from "../../common/use-anchored-reveal";
import { useStickToBottom } from "../../common/use-stick-to-bottom";
import {
  IssueActivitySection,
  STICK_PIN_THRESHOLD_PX,
} from "./issue-activity-section";
import { IssueDescriptionSection } from "./issue-description-section";
import { IssueDetailHeader } from "./issue-detail-header";
import { IssueDecisionPanel } from "./issue-decision-panel";
import { IssueSessionList } from "./issue-session-list";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useT } from "../../i18n";

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
  getActorName: (type: string, id: string) => string;
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
  getActorName,
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
  const decisions = useQuery(issueDecisionsOptions(wsId, issueId));
  const hasDecisionEntries = (issue.pending_decision_count ?? 0) > 0
    || (decisions.data?.waiting_on_human.length ?? 0) > 0
    || (decisions.data?.owner_and_answered.pending.length ?? 0) > 0
    || (decisions.data?.owner_and_answered.answered.length ?? 0) > 0;
  const waitingOn = dependencies
    .filter((dependency) => dependency.direction === "blocked_by" && dependency.depends_on_issue?.status !== "done")
    .map((dependency) => dependency.depends_on_issue?.identifier)
    .filter((key): key is string => !!key);
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
      setForceStartOpen(false);
    } catch (error) {
      setForceStartError(error instanceof Error ? error.message : t(($) => $.detail.force_start_failed));
    }
  };
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
    // Named explicitly rather than left to the hook's default: the consumer's
    // own at-bottom gate has to use the same number, and a silent default would
    // let the two drift apart.
    pinThresholdPx: STICK_PIN_THRESHOLD_PX,
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

      <div
        className={`flex h-10 shrink-0 items-center border-b px-4 ${
          hasDecisionEntries
            ? "bg-blue-50/70 dark:bg-blue-950/20"
            : ""
        }`}
        data-issue-notice-slot
      >
        {hasDecisionEntries && (
          <IssueDecisionPanel
            issueId={issueId}
            pendingCount={issue.pending_decision_count ?? 0}
            showOwnerOnly={(issue.pending_decision_count ?? 0) === 0}
            canAnswer={canForceStart}
            getActorName={getDecisionActorName}
          />
        )}
        {!hasDecisionEntries
          && issue.parent_issue_id !== null
          && issue.status === "backlog"
          && waitingOn.length > 0 && (
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
      </div>

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
              onReturnToBottom={stick.returnToBottom}
              stickState={stick.state}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
