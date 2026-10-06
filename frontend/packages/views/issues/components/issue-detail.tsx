"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { api, ApiError } from "@multiremi/core/api";
import { defaultStorage } from "@multiremi/core/platform";
import { ChevronLeft } from "lucide-react";
import { useFloatingPanelLayout } from "../../layout/floating-panel-layout";
import { useNavigation } from "../../navigation";
import { Button } from "@multiremi/ui/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@multiremi/ui/components/ui/resizable";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useScmSettings } from "@multiremi/core/scm";
import { useSSRUser } from "@multiremi/core/platform/ssr-workspace";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import { issueKeys } from "@multiremi/core/issues/queries";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useRecentContextStore } from "@multiremi/core/chat";
import {
  childIssuesOptions,
  findCachedIssue,
  issueDetailOptions,
  issueUsageOptions,
} from "@multiremi/core/issues/queries";
import { projectDetailOptions } from "@multiremi/core/projects/queries";
import { issueLabelsOptions } from "@multiremi/core/labels";
import { memberListOptions, agentListOptions } from "@multiremi/core/workspace/queries";
import { useRecentIssuesStore } from "@multiremi/core/issues/stores";
import { useIssueDetailPreferencesStore } from "@multiremi/core/issues/stores";
import { useIssueSelectionStore } from "@multiremi/core/issues/stores/selection-store";
import { useIssueActions } from "../actions";
import { useIssueSessionSelection } from "../hooks/use-issue-session-selection";
import { useOptionalProps } from "../hooks/use-optional-props";
import { useSidebarSections } from "../hooks/use-sidebar-sections";
import { KEY_RESULTS_SECTION_ID } from "./issue-key-results-section";
import { IssueDetailMain } from "./issue-detail-main";
import { IssueDetailSidebar } from "./issue-detail-sidebar";
import { IssueDetailSkeleton } from "./issue-detail-skeleton";
import { useT } from "../../i18n";
import { useAfterFirstScreen, useRouteContentReady } from "@multiremi/core/platform/use-after-first-screen";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IssueDetailProps {
  issueId: string;
  initialLog?: IssueLogBootstrap;
  onDelete?: () => void;
  /** Called after the issue is marked as done via the toolbar button. */
  onDone?: () => void;
  defaultSidebarOpen?: boolean;
  layoutId?: string;
  /** When set, the issue detail will auto-scroll to this comment and briefly highlight it. */
  highlightCommentId?: string;
  /** Selects the product Session that owns a deep-linked comment. */
  initialIssueSessionId?: string;
  /** Lets the host decide whether and how Session selection changes its URL. */
  onIssueSessionChange?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// IssueDetail
// ---------------------------------------------------------------------------

/**
 * Two slots inside a resizable group: `IssueDetailMain` (the document) and
 * `IssueDetailSidebar` (the property rail). This component owns the data both
 * slots share and the state that has to outlive either of them collapsing.
 */
export function IssueDetail({
  issueId,
  initialLog,
  onDelete,
  onDone,
  defaultSidebarOpen = true,
  layoutId = "multimira_issue_detail_layout",
  highlightCommentId,
  initialIssueSessionId,
  onIssueSessionChange,
}: IssueDetailProps) {
  const { t } = useT("issues");
  const id = issueId;
  const { registerRightRail } = useFloatingPanelLayout();
  const router = useNavigation();
  const { pathname } = router;
  const { user } = useSSRUser();
  const paths = useWorkspacePaths();

  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const membersQuery = useQuery(memberListOptions(wsId));
  const members = membersQuery.data ?? [];
  const routeAfterFirstScreen = useAfterFirstScreen({ routeKey: pathname });
  // Inbox changes its selected detail without changing the pathname. The
  // already-open route gate cannot stand in for this detail's own reveal.
  const visit = `${id}:${initialIssueSessionId ?? ""}:${highlightCommentId ?? ""}`;
  const [revealedVisit, setRevealedVisit] = useState({ visit, ready: false });
  if (revealedVisit.visit !== visit) setRevealedVisit({ visit, ready: false });
  const afterFirstScreen = routeAfterFirstScreen && revealedVisit.visit === visit && revealedVisit.ready;
  const onDetailRevealed = useCallback(() => {
    setRevealedVisit(current => current.visit === visit && !current.ready ? { visit, ready: true } : current);
  }, [visit]);
  const { data: agents = [] } = useQuery(agentListOptions(wsId, { enabled: afterFirstScreen }));
  const resolveDeepLinkSession = Boolean(highlightCommentId && !initialIssueSessionId
    && initialLog?.missingCommentId !== highlightCommentId
    && initialLog?.targetCommentId !== highlightCommentId);
  const sessions = useIssueSessionSelection(
    id,
    initialIssueSessionId,
    onIssueSessionChange,
    resolveDeepLinkSession,
  );
  const [locatedSession, setLocatedSession] = useState<{ issueId: string; commentId: string; sessionId: string; missing: boolean } | null>(null);
  const resolution = locatedSession?.issueId === id
    && locatedSession.commentId === highlightCommentId ? locatedSession : null;
  const matchedSession = resolution?.sessionId ?? null;
  useEffect(() => {
    if (!resolveDeepLinkSession || !highlightCommentId || sessions.list.length === 0 || matchedSession !== null) return;
    let active = true;
    void Promise.allSettled(sessions.list.map(async session => {
      try {
        const location = await api.locateSessionLogEntry(session.id, highlightCommentId);
        if (location.id !== highlightCommentId) throw new Error("Located entry does not match the requested comment");
        return session.id;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    })).then(results => {
      if (!active) return;
      const found = results.find(result => result.status === "fulfilled" && result.value !== null);
      const failed = !found && results.some(result => result.status === "rejected");
      const missing = !found && !failed;
      const sessionId = found?.status === "fulfilled" ? found.value! : failed ? ""
        : sessions.list.find(session => session.is_default)?.id ?? sessions.list[0]!.id;
      setLocatedSession({ issueId: id, commentId: highlightCommentId, sessionId, missing });
      if (sessionId) sessions.select(sessionId);
    });
    return () => { active = false; };
  }, [id, highlightCommentId, matchedSession, resolveDeepLinkSession, sessions.list, sessions.select]);
  const activitySessions = resolveDeepLinkSession
    ? { ...sessions, activeId: matchedSession ?? "", active: sessions.list.find(s => s.id === matchedSession) ?? null,
        pending: matchedSession === null || sessions.pending,
        refetch: () => { setLocatedSession(null); sessions.refetch(); } }
    : sessions;
  // Begin the window as soon as sessions resolve, including while member or
  // children queries still hold the existing render gates closed.
  const log = useIssueLog(activitySessions.activeId, initialLog,
    resolution?.missing || initialLog?.missingCommentId === highlightCommentId ? undefined : highlightCommentId,
    false, true, activitySessions.active?.is_default === true);
  // Same key/policy as the sidebar: one request independent of the log read.
  useQuery({ queryKey: issueKeys.tasks(id), queryFn: () => api.listTasksByIssue(id),
    staleTime: 30_000, refetchOnWindowFocus: true });
  // Workspace owners and admins moderate any comment authored by anyone
  // (mirrors backend `comment.go:507-512`). Computed here so per-comment
  // rendering doesn't have to re-derive it for every row.
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const currentUserRole = currentMember?.role ?? null;
  const isMember = currentMember !== null;
  const canModerateComments =
    currentUserRole === "owner" || currentUserRole === "admin";
  const { getActorName } = useActorName();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: layoutId,
    storage: defaultStorage,
  });
  const sidebarRef = usePanelRef();
  const isMobile = useIsMobile();
  const sessionSidebarOpen = useIssueDetailPreferencesStore(
    (state) => state.sessionSidebarOpen,
  );
  const toggleSessionSidebar = useIssueDetailPreferencesStore(
    (state) => state.toggleSessionSidebar,
  );
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(defaultSidebarOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileSessionSidebarOpen, setMobileSessionSidebarOpen] = useState(false);

  useEffect(() => {
    if (isMobile) {
      setMobileSidebarOpen(false);
      setMobileSessionSidebarOpen(false);
    }
  }, [id, isMobile]);
  const sidebarOpen = isMobile ? mobileSidebarOpen : desktopSidebarOpen;
  const visibleSessionSidebarOpen = isMobile
    ? mobileSessionSidebarOpen
    : sessionSidebarOpen;
  const sections = useSidebarSections();
  const scmSettings = useScmSettings();

  // Virtuoso's `customScrollParent` wants the HTMLElement, not a ref. A plain
  // `useRef.current` does not trigger a re-render when it populates, so the
  // Virtuoso prop would never receive the element. Callback ref + state fixes
  // that: setState triggers the re-render that hands Virtuoso the element.
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);

  // Issue data from TQ. A list row is not a valid detail seed: the global query
  // staleTime is infinite, so accepting one would suppress the detail request
  // that carries pending_decision_count and the server-derived grant state.
  const { data: issue = null, isLoading: issueLoading } = useQuery({
    ...issueDetailOptions(wsId, id),
    initialData: () => {
      const cached = findCachedIssue(queryClient, wsId, id);
      return cached?.description != null
        && cached.pending_decision_count !== undefined
        && Object.prototype.hasOwnProperty.call(cached, "parent_done_grant")
        ? cached
        : undefined;
    },
  });
  const childIssuesQuery = useQuery({
    ...childIssuesOptions(wsId, id),
    enabled: !!issue,
  });
  const childIssues = childIssuesQuery.data ?? [];

  // Record recent visit
  const recordVisit = useRecentIssuesStore((s) => s.recordVisit);
  const recordRecentContext = useRecentContextStore((s) => s.recordVisit);
  useEffect(() => {
    if (issue) {
      recordVisit(wsId, issue.id);
      recordRecentContext(wsId, {
        type: "issue",
        id: issue.id,
        label: issue.identifier,
        subtitle: issue.title,
        status: issue.status,
      });
    }
  }, [issue?.id, wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire `onDelete` once when the issue transitions from loaded to missing.
  // Delete goes through a shell-level modal, so the caller (e.g. inbox) can't
  // be notified directly — instead, the detail page observes its own cache
  // clearing and runs the callback. We navigate via `onDeletedNavigateTo` on
  // the actions menu when no callback is supplied (standalone routes).
  const hadIssueRef = useRef(false);
  const firedDeleteCallbackRef = useRef(false);
  useEffect(() => {
    if (issue) {
      hadIssueRef.current = true;
      firedDeleteCallbackRef.current = false;
      return;
    }
    if (
      hadIssueRef.current &&
      !issueLoading &&
      !firedDeleteCallbackRef.current &&
      onDelete
    ) {
      firedDeleteCallbackRef.current = true;
      onDelete();
    }
  }, [issue, issueLoading, onDelete]);

  // Token usage — sidebar only, but queried here so the mobile sheet doesn't
  // have to be opened before the numbers start loading.
  const { data: usage } = useQuery({ ...issueUsageOptions(id), enabled: afterFirstScreen });

  // Sub-issue queries
  const parentIssueId = issue?.parent_issue_id;
  const { data: parentIssue = null } = useQuery({
    ...issueDetailOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
    initialData: () =>
      parentIssueId ? findCachedIssue(queryClient, wsId, parentIssueId) : undefined,
  });

  // Project segment in the breadcrumb. The issue's project_id is the source of
  // truth — same URL renders the same breadcrumb regardless of entry path.
  const issueProjectId = issue?.project_id;
  const { data: breadcrumbProject = null } = useQuery({
    ...projectDetailOptions(wsId, issueProjectId ?? ""),
    enabled: !!issueProjectId,
  });

  // Selection store is global (workspace-scoped); clear it whenever this
  // issue detail is mounted or switched, so leftover selections from the
  // main list view (or another sub-issue list) don't leak into this one.
  const clearSelection = useIssueSelectionStore((s) => s.clear);
  useEffect(() => {
    clearSelection();
    return clearSelection;
  }, [id, clearSelection]);

  const loading = issueLoading
    || membersQuery.isPending
    || (!!issue && childIssuesQuery.isPending);
  useRouteContentReady(pathname, !issueLoading && !issue);

  // Shared issue actions (mutations, pin, copy-link, modal dispatch, etc.).
  // Called before the `if (!issue)` early return so hook order stays stable.
  const actions = useIssueActions(issue);

  // Labels live in their own query (not on the issue body) — fetch the count
  // here so seeding can decide whether the "Labels" optional row should be
  // shown for an issue that already has labels attached.
  const { data: attachedLabels = [] } = useQuery({ ...issueLabelsOptions(wsId, id), enabled: afterFirstScreen });
  const optionalProps = useOptionalProps(issue, attachedLabels.length);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((open) => !open);
      return;
    }

    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [isMobile, sidebarRef]);

  const handleToggleSessionSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSessionSidebarOpen((open) => !open);
      return;
    }
    toggleSessionSidebar();
  }, [isMobile, toggleSessionSidebar]);

  // A timeline "published a result" line points at the panel section that
  // holds the result itself. Open the panel first when it is closed —
  // otherwise the click would scroll to something the user can't see.
  const handleShowKeyResults = useCallback(() => {
    if (!sidebarOpen) handleToggleSidebar();
    document
      .getElementById(KEY_RESULTS_SECTION_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [handleToggleSidebar, sidebarOpen]);

  if (loading) {
    return <IssueDetailSkeleton />;
  }

  if (!issue) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{t(($) => $.detail.not_found)}</p>
        {!onDelete && (
          <Button variant="outline" size="sm" onClick={() => router.push(paths.issues())}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            {t(($) => $.detail.back_to_issues)}
          </Button>
        )}
      </div>
    );
  }

  const sidebarContent = (
    <IssueDetailSidebar
      issue={issue}
      issueId={id}
      queriesEnabled={afterFirstScreen}
      sections={sections}
      optionalProps={optionalProps}
      onUpdateField={actions.updateField}
      parentIssue={parentIssue}
      changeSidebarEnabled={scmSettings.changeSidebar}
      getActorName={getActorName}
      issueSessions={sessions.list}
      usage={usage}
      canManageArchives={canModerateComments}
      isMember={isMember}
      childIssues={childIssues}
      onCreateSubIssue={actions.openCreateSubIssue}
    />
  );

  const detailContent = (
    <IssueDetailMain
      onRevealed={onDetailRevealed}
      log={log}
      issue={issue}
      issueId={id}
      parentIssue={parentIssue}
      breadcrumbProject={breadcrumbProject}
      actions={actions}
      onDone={onDone}
      // When a parent passes `onDelete`, we detect deletion via the effect
      // above and skip navigation. Otherwise the modal navigates for us.
      onDeletedNavigateTo={onDelete ? undefined : paths.issues()}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={handleToggleSidebar}
      isMobile={isMobile}
      sessionSidebarOpen={visibleSessionSidebarOpen}
      onToggleSessionSidebar={handleToggleSessionSidebar}
      sessions={activitySessions}
      members={members}
      agents={agents}
      currentUserId={user?.id}
      canModerateComments={canModerateComments}
      getActorName={getActorName}
      highlightCommentId={resolution?.missing || initialLog?.missingCommentId === highlightCommentId ? undefined : highlightCommentId}
      initialLog={initialLog}
      onShowKeyResults={handleShowKeyResults}
      onScrollContainerRef={setScrollContainerEl}
      scrollContainerEl={scrollContainerEl}
      canForceStart={isMember}
    />
  );

  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0">
        {detailContent}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="right" showCloseButton={false} className="w-[320px] overflow-y-auto p-4">
            {sidebarContent}
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="content" minSize="50%">
        {detailContent}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id="sidebar"
        defaultSize={defaultSidebarOpen ? 320 : 0}
        minSize={260}
        maxSize={420}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        panelRef={sidebarRef}
        onResize={(size) => setDesktopSidebarOpen(size.inPixels > 0)}
      >
      <div ref={registerRightRail} data-issue-detail-sidebar="" className="overflow-y-auto border-l h-full">
        <div className="p-4">
          {sidebarContent}
        </div>
      </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
